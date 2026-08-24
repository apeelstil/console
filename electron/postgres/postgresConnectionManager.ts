import type { ClientConfig } from 'pg';
import type {
  ActiveConnectionInfo,
  ConnectionRequest,
  ConnectionState,
  ConnectionTestResult,
} from '../../shared/postgresConnection';
import { hasValidationErrors, validateProfileFields } from '../../shared/profileValidation';
import type { StoredConnectionProfile } from '../storage/connectionProfileRepository';
import type { CredentialStorage } from '../storage/credentialStorage';
import {
  PostgresOperationBlockedError,
  PostgresOperationGate,
} from './postgresOperationGate';

const CONNECTION_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_SQL = 'SELECT 1;';

export interface PostgresClient {
  connect(): Promise<unknown>;
  query(query: string | PostgresQueryConfig): Promise<PostgresQueryResult>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}

export interface PostgresQueryConfig {
  text: string;
  values?: unknown[];
  query_timeout?: number;
  rowMode?: 'array';
}

export interface PostgresField {
  name: string;
  dataTypeID: number;
}

export interface PostgresQueryResult {
  rows: unknown[];
  fields?: readonly PostgresField[];
  rowCount?: number | null;
}

export interface ActiveClientAccess {
  mutationTransactionId?: string;
  selectOperationId?: string;
}

export type PostgresClientFactory = (config: ClientConfig) => PostgresClient;

export interface ConnectionProfileProvider {
  findById(id: string): StoredConnectionProfile | undefined;
}

interface ResolvedConnection {
  metadata: ActiveConnectionInfo;
  password: string;
}

type StateListener = (state: ConnectionState) => void;

export class ConnectionManagerError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'ConnectionManagerError';
  }
}

export class PostgresConnectionManager {
  private state: ConnectionState = { status: 'DISCONNECTED' };
  private activeClient: PostgresClient | undefined;
  private testingClient: PostgresClient | undefined;
  private disconnectPromise: Promise<ConnectionState> | undefined;
  private readonly listeners = new Set<StateListener>();
  private readonly clientEndOperations = new WeakMap<PostgresClient, Promise<void>>();
  private activeClientOperationTail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private beforeDisconnect: (() => Promise<void>) | undefined;

  constructor(
    private readonly createClient: PostgresClientFactory,
    private readonly profiles: ConnectionProfileProvider,
    private readonly credentials: CredentialStorage,
    private readonly operationGate: PostgresOperationGate = new PostgresOperationGate(),
  ) {}

  getConnectionState(): ConnectionState {
    return cloneState(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async withActiveClient<T>(
    operation: (client: PostgresClient) => Promise<T>,
    access: ActiveClientAccess = {},
  ): Promise<T> {
    const previousOperation = this.activeClientOperationTail;
    let releaseOperation: () => void = () => undefined;
    this.activeClientOperationTail = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    await previousOperation;
    try {
      if (access.mutationTransactionId) {
        this.operationGate.assertMutationOwner(access.mutationTransactionId);
      } else if (access.selectOperationId) {
        this.operationGate.assertSelectOwner(access.selectOperationId);
      } else {
        this.operationGate.assertStandardOperationAllowed();
      }
      const client = this.activeClient;
      if (this.state.status !== 'CONNECTED' || !client) {
        throw new ConnectionManagerError('No active database connection.');
      }

      const result = await operation(client);
      if (this.state.status !== 'CONNECTED' || this.activeClient !== client) {
        throw new ConnectionManagerError('No active database connection.');
      }
      return result;
    } finally {
      releaseOperation();
    }
  }

  setBeforeDisconnectHandler(handler: () => Promise<void>): void {
    this.beforeDisconnect = handler;
  }

  async testConnection(request: ConnectionRequest): Promise<ConnectionTestResult> {
    this.assertOperationAllowed('test');
    this.setState({ status: 'TESTING', message: 'Testing connection…' });
    const startedAt = Date.now();
    let client: PostgresClient | undefined;

    try {
      const resolved = this.resolveConnection(request);
      client = this.createClient(createClientConfig(resolved));
      this.testingClient = client;
      client.on('error', () => undefined);
      await client.connect();
      await client.query(HEALTH_CHECK_SQL);
      if (this.shuttingDown) throw new ConnectionManagerError('The connection test was cancelled.');
      const result: ConnectionTestResult = {
        message: 'Connection successful',
        durationMs: Date.now() - startedAt,
      };
      this.setState({ status: 'DISCONNECTED', message: result.message });
      return result;
    } catch (error: unknown) {
      const safeMessage = getSafeConnectionError(error);
      this.setState({ status: 'ERROR', message: safeMessage });
      throw new ConnectionManagerError(safeMessage);
    } finally {
      if (client) {
        if (this.testingClient === client) this.testingClient = undefined;
        await this.endClientOnce(client);
      }
    }
  }

  async connect(request: ConnectionRequest): Promise<ConnectionState> {
    this.assertOperationAllowed('connect');

    let resolved: ResolvedConnection;
    try {
      resolved = this.resolveConnection(request);
    } catch (error: unknown) {
      const safeMessage = getSafeConnectionError(error);
      this.setState({ status: 'ERROR', message: safeMessage });
      throw new ConnectionManagerError(safeMessage);
    }

    this.setState({ status: 'CONNECTING', connection: resolved.metadata, message: 'Connecting…' });
    let client: PostgresClient;
    try {
      client = this.createClient(createClientConfig(resolved));
    } catch (error: unknown) {
      const safeMessage = getSafeConnectionError(error);
      this.setState({ status: 'ERROR', message: safeMessage });
      throw new ConnectionManagerError(safeMessage);
    }

    this.activeClient = client;
    client.on('error', (error) => this.handleUnexpectedLoss(client, error));
    client.on('end', () => this.handleUnexpectedLoss(client));

    try {
      await client.connect();
      if (this.activeClient !== client || this.shuttingDown) {
        throw new ConnectionManagerError('The connection attempt was cancelled.');
      }
      this.setState({ status: 'CONNECTED', connection: resolved.metadata, message: 'Connected' });
      return this.getConnectionState();
    } catch (error: unknown) {
      if (this.activeClient === client) this.activeClient = undefined;
      await this.endClientOnce(client);
      const safeMessage = getSafeConnectionError(error);
      this.setState({ status: 'ERROR', message: safeMessage });
      throw new ConnectionManagerError(safeMessage);
    }
  }

  disconnect(): Promise<ConnectionState> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = (async () => {
      const client = this.activeClient;
      if (!client) {
        this.setState({ status: 'DISCONNECTED' });
        return this.getConnectionState();
      }

      try {
        await this.beforeDisconnect?.();
      } catch {
        // Disconnect still closes the client after a best-effort transaction rollback.
      }

      if (this.activeClient === client) this.activeClient = undefined;
      this.setState({ status: 'DISCONNECTING', connection: this.state.connection, message: 'Disconnecting…' });
      await this.endClientOnce(client);
      this.setState({ status: 'DISCONNECTED' });
      return this.getConnectionState();
    })().finally(() => {
      this.disconnectPromise = undefined;
    });

    return this.disconnectPromise;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const testingClient = this.testingClient;
    this.testingClient = undefined;
    if (testingClient) await this.endClientOnce(testingClient);
    await this.disconnect();
    this.listeners.clear();
  }

  private resolveConnection(request: ConnectionRequest): ResolvedConnection {
    if (request.source === 'profile') {
      const profile = this.profiles.findById(request.profileId);
      if (!profile) throw new ConnectionManagerError('The selected connection profile no longer exists.');

      const password = request.temporaryPassword || this.decryptStoredPassword(profile);
      if (!password) throw new ConnectionManagerError('Enter a password for this connection.');
      return {
        metadata: toActiveConnectionInfo(profile),
        password,
      };
    }

    const validationErrors = validateProfileFields(request.connection);
    if (hasValidationErrors(validationErrors)) {
      throw new ConnectionManagerError('Check the required connection fields and try again.');
    }
    if (!request.temporaryPassword) throw new ConnectionManagerError('Enter a password for this connection.');

    return {
      metadata: normalizeConnectionInfo(request.connection),
      password: request.temporaryPassword,
    };
  }

  private decryptStoredPassword(profile: StoredConnectionProfile): string {
    if (!profile.encryptedPassword) return '';
    if (!this.credentials.isEncryptionAvailable()) {
      throw new ConnectionManagerError('Windows credential encryption is unavailable. Enter the password manually.');
    }

    try {
      return this.credentials.decrypt(profile.encryptedPassword);
    } catch {
      throw new ConnectionManagerError('The stored password could not be decrypted. Enter the password manually.');
    }
  }

  private assertOperationAllowed(operation: 'test' | 'connect'): void {
    try {
      this.operationGate.assertStandardOperationAllowed();
    } catch (error: unknown) {
      if (error instanceof PostgresOperationBlockedError) {
        throw new ConnectionManagerError(error.safeMessage);
      }
      throw error;
    }
    if (this.shuttingDown) throw new ConnectionManagerError('The application is shutting down.');
    if (this.state.status === 'CONNECTED' || this.state.status === 'DISCONNECTING') {
      throw new ConnectionManagerError('Disconnect the active database before choosing another connection.');
    }
    if (this.state.status === 'CONNECTING' || this.state.status === 'TESTING') {
      throw new ConnectionManagerError(`A connection ${operation === 'test' ? 'operation' : 'attempt'} is already in progress.`);
    }
  }

  private handleUnexpectedLoss(client: PostgresClient, error?: Error): void {
    if (this.activeClient !== client) return;
    this.activeClient = undefined;
    const message = error ? getSafeConnectionError(error) : 'The PostgreSQL connection was closed unexpectedly.';
    this.setState({ status: 'ERROR', message });
    void this.endClientOnce(client);
  }

  private endClientOnce(client: PostgresClient): Promise<void> {
    const existingOperation = this.clientEndOperations.get(client);
    if (existingOperation) return existingOperation;

    const operation = (async () => {
      try {
        await client.end();
      } catch {
        // Cleanup errors are intentionally hidden and never include connection secrets.
      }
    })();
    this.clientEndOperations.set(client, operation);
    return operation;
  }

  private setState(state: ConnectionState): void {
    this.state = cloneState(state);
    for (const listener of this.listeners) {
      try {
        listener(this.getConnectionState());
      } catch {
        // A renderer notification failure must not affect the database lifecycle.
      }
    }
  }
}

function createClientConfig(connection: ResolvedConnection): ClientConfig {
  return {
    host: connection.metadata.host,
    port: connection.metadata.port,
    database: connection.metadata.database,
    user: connection.metadata.username,
    password: connection.password,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    application_name: 'SUPRA Query Console',
  };
}

function toActiveConnectionInfo(profile: StoredConnectionProfile): ActiveConnectionInfo {
  return {
    profileId: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    username: profile.username,
    environment: profile.environment,
  };
}

function normalizeConnectionInfo(connection: ActiveConnectionInfo): ActiveConnectionInfo {
  return {
    name: connection.name.trim(),
    host: connection.host.trim(),
    port: connection.port,
    database: connection.database.trim(),
    username: connection.username.trim(),
    environment: connection.environment,
  };
}

function cloneState(state: ConnectionState): ConnectionState {
  return {
    status: state.status,
    ...(state.connection ? { connection: { ...state.connection } } : {}),
    ...(state.message ? { message: state.message } : {}),
  };
}

interface SafeErrorShape {
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

export function getSafeConnectionError(error: unknown): string {
  if (error instanceof ConnectionManagerError) return error.safeMessage;
  const details = typeof error === 'object' && error !== null ? error as SafeErrorShape : {};
  const code = typeof details.code === 'string' ? details.code : '';
  const message = typeof details.message === 'string' ? details.message.toLowerCase() : '';

  if (code === '28P01' || message.includes('password authentication failed')) {
    return 'Authentication failed. Check the username and password.';
  }
  if (code === '3D000') return 'The specified database does not exist.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The database host could not be resolved.';
  if (code === 'ECONNREFUSED') return 'The database server refused the connection.';
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT' || message.includes('timeout')) {
    return 'The database server did not respond before the connection timeout.';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The database server is unreachable.';
  return 'PostgreSQL connection failed. Check the connection settings and server availability.';
}
