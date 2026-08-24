import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConfig } from 'pg';
import {
  ConnectionManagerError,
  getSafeConnectionError,
  PostgresConnectionManager,
  type ConnectionProfileProvider,
  type PostgresClient,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from '../electron/postgres/postgresConnectionManager';
import type { StoredConnectionProfile } from '../electron/storage/connectionProfileRepository';
import type { CredentialStorage } from '../electron/storage/credentialStorage';

const storedProfile: StoredConnectionProfile = {
  id: 'b157d9de-6ef2-4eae-bfea-0fb44f5036d9',
  name: 'SUPRA TEST',
  host: 'test-host',
  port: 5432,
  database: 'supra_test',
  username: 'support_user',
  environment: 'TEST',
  encryptedPassword: Buffer.from('encrypted-test-password'),
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
};

const temporaryRequest = {
  source: 'temporary' as const,
  connection: {
    name: 'Temporary test',
    host: 'temporary-host',
    port: 5432,
    database: 'temporary_database',
    username: 'temporary_user',
    environment: 'DEV' as const,
  },
  temporaryPassword: 'temporary-password',
};

class FakeProfileProvider implements ConnectionProfileProvider {
  findCalls = 0;

  constructor(private readonly profile?: StoredConnectionProfile) {}

  findById(id: string): StoredConnectionProfile | undefined {
    this.findCalls += 1;
    return this.profile?.id === id ? this.profile : undefined;
  }
}

class FakeCredentialStorage implements CredentialStorage {
  decryptCalls = 0;

  constructor(private readonly decryptedPassword = 'stored-password') {}

  isEncryptionAvailable(): boolean {
    return true;
  }

  encrypt(password: string): Buffer {
    return Buffer.from(password);
  }

  decrypt(encryptedPassword: Buffer): string {
    assert.notEqual(encryptedPassword.length, 0);
    this.decryptCalls += 1;
    return this.decryptedPassword;
  }
}

class FakePostgresClient implements PostgresClient {
  connectCalls = 0;
  endCalls = 0;
  queries: string[] = [];
  connectImplementation: () => Promise<unknown> = async () => undefined;
  queryImplementation: (query: string | PostgresQueryConfig) => Promise<PostgresQueryResult> = async () => ({ rows: [{ '?column?': 1 }] });
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly endListeners: Array<() => void> = [];

  async connect(): Promise<unknown> {
    this.connectCalls += 1;
    return this.connectImplementation();
  }

  async query(query: string | PostgresQueryConfig): Promise<PostgresQueryResult> {
    this.queries.push(typeof query === 'string' ? query : query.text);
    return this.queryImplementation(query);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  on(event: 'error' | 'end', listener: ((error: Error) => void) | (() => void)): this {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.endListeners.push(listener as () => void);
    return this;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  emitEnd(): void {
    for (const listener of this.endListeners) listener();
  }
}

function createHarness(profile?: StoredConnectionProfile) {
  const clients: FakePostgresClient[] = [];
  const configs: ClientConfig[] = [];
  const profiles = new FakeProfileProvider(profile);
  const credentials = new FakeCredentialStorage();
  const manager = new PostgresConnectionManager(
    (config) => {
      configs.push(config);
      const client = new FakePostgresClient();
      clients.push(client);
      return client;
    },
    profiles,
    credentials,
  );
  return { manager, clients, configs, profiles, credentials };
}

test('Scenario A: successful test uses a temporary Client, SELECT 1, and always closes it', async () => {
  const harness = createHarness();
  const result = await harness.manager.testConnection(temporaryRequest);

  assert.equal(result.message, 'Connection successful');
  assert.equal(harness.clients.length, 1);
  assert.equal(harness.clients[0]?.connectCalls, 1);
  assert.deepEqual(harness.clients[0]?.queries, ['SELECT 1;']);
  assert.equal(harness.clients[0]?.endCalls, 1);
  assert.equal(harness.configs[0]?.connectionTimeoutMillis, 10_000);
  assert.equal(harness.configs[0]?.keepAlive, true);
  assert.equal(harness.configs[0]?.application_name, 'SUPRA Query Console');
  assert.equal(harness.configs[0]?.ssl, undefined);
  assert.deepEqual(harness.manager.getConnectionState(), {
    status: 'DISCONNECTED',
    message: 'Connection successful',
  });
});

test('Scenario B: failed test returns a safe error, closes the temporary Client, and creates no active connection', async () => {
  const harness = createHarness();
  const client = new FakePostgresClient();
  const unsafePassword = 'secret-that-must-not-leak';
  client.connectImplementation = async () => {
    const error = new Error(`password authentication failed: ${unsafePassword}`) as Error & { code: string };
    error.code = '28P01';
    throw error;
  };
  const manager = new PostgresConnectionManager(() => client, harness.profiles, harness.credentials);

  await assert.rejects(
    () => manager.testConnection(temporaryRequest),
    (error: unknown) => error instanceof ConnectionManagerError
      && error.safeMessage === 'Authentication failed. Check the username and password.'
      && !error.safeMessage.includes(unsafePassword),
  );
  assert.equal(client.endCalls, 1);
  assert.equal(manager.getConnectionState().connection, undefined);
  assert.equal(manager.getConnectionState().status, 'ERROR');
});

test('Scenario C: permanent Connect retains one Client and exposes metadata without a password', async () => {
  const harness = createHarness();
  const state = await harness.manager.connect(temporaryRequest);

  assert.equal(harness.clients[0]?.connectCalls, 1);
  assert.equal(harness.clients[0]?.endCalls, 0);
  assert.equal(state.status, 'CONNECTED');
  assert.equal(state.connection?.database, temporaryRequest.connection.database);
  assert.equal('password' in (state.connection ?? {}), false);
  assert.equal('temporaryPassword' in state, false);
});

test('Scenario D: Disconnect closes and releases the active Client and is safe to repeat', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);

  const state = await harness.manager.disconnect();
  const repeatedState = await harness.manager.disconnect();

  assert.equal(harness.clients[0]?.endCalls, 1);
  assert.deepEqual(state, { status: 'DISCONNECTED' });
  assert.deepEqual(repeatedState, { status: 'DISCONNECTED' });
});

test('an active-client callback failure leaves the valid permanent connection intact', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);

  await assert.rejects(
    () => harness.manager.withActiveClient(async () => {
      throw Object.assign(new Error('metadata permission denied'), { code: '42501' });
    }),
  );

  assert.equal(harness.manager.getConnectionState().status, 'CONNECTED');
  assert.equal(harness.clients[0]?.endCalls, 0);
  await harness.manager.disconnect();
});

test('active-client callbacks are serialized to prevent metadata interleaving with transactions', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);
  const releaseFirst = createDeferred<void>();
  const operations: string[] = [];

  const first = harness.manager.withActiveClient(async () => {
    operations.push('first-start');
    await releaseFirst.promise;
    operations.push('first-end');
  });
  const second = harness.manager.withActiveClient(async () => {
    operations.push('second');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(operations, ['first-start']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(operations, ['first-start', 'first-end', 'second']);
  await harness.manager.disconnect();
});

test('Scenario E: stored credential is decrypted only inside the manager and never enters the public DTO', async () => {
  const harness = createHarness(storedProfile);
  const state = await harness.manager.connect({ source: 'profile', profileId: storedProfile.id });

  assert.equal(harness.credentials.decryptCalls, 1);
  assert.equal(harness.configs[0]?.password, 'stored-password');
  assert.equal(state.connection?.profileId, storedProfile.id);
  assert.equal('password' in (state.connection ?? {}), false);
  assert.equal(JSON.stringify(state).includes('stored-password'), false);
  await harness.manager.disconnect();
});

test('Scenario F: temporary unsaved password is used without accessing or modifying profile storage', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);

  assert.equal(harness.credentials.decryptCalls, 0);
  assert.equal(harness.configs[0]?.password, temporaryRequest.temporaryPassword);
  assert.equal(harness.profiles.findCalls, 0);
  assert.equal(JSON.stringify(harness.manager.getConnectionState()).includes(temporaryRequest.temporaryPassword), false);
  await harness.manager.disconnect();
});

test('a temporary password overrides a stored password without replacing it', async () => {
  const harness = createHarness(storedProfile);
  const override = 'one-time-override';
  await harness.manager.connect({ source: 'profile', profileId: storedProfile.id, temporaryPassword: override });

  assert.equal(harness.credentials.decryptCalls, 0);
  assert.equal(harness.configs[0]?.password, override);
  assert.deepEqual(storedProfile.encryptedPassword, Buffer.from('encrypted-test-password'));
  await harness.manager.disconnect();
});

test('Scenario G: a second parallel permanent Connect is blocked', async () => {
  const deferred = createDeferred<void>();
  const firstClient = new FakePostgresClient();
  firstClient.connectImplementation = () => deferred.promise;
  let factoryCalls = 0;
  const manager = new PostgresConnectionManager(
    () => {
      factoryCalls += 1;
      return firstClient;
    },
    new FakeProfileProvider(),
    new FakeCredentialStorage(),
  );

  const firstConnect = manager.connect(temporaryRequest);
  await assert.rejects(
    () => manager.connect(temporaryRequest),
    (error: unknown) => error instanceof ConnectionManagerError && error.safeMessage.includes('already in progress'),
  );
  assert.equal(factoryCalls, 1);

  deferred.resolve();
  await firstConnect;
  await manager.disconnect();
});

test('Scenario H: unexpected Client error does not throw, clears the Client, and publishes safe ERROR state', async () => {
  const harness = createHarness();
  const states: string[] = [];
  harness.manager.subscribe((state) => states.push(state.status));
  await harness.manager.connect(temporaryRequest);

  assert.doesNotThrow(() => harness.clients[0]?.emitError(Object.assign(new Error('socket failed'), { code: 'ECONNREFUSED' })));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const state = harness.manager.getConnectionState();
  assert.equal(state.status, 'ERROR');
  assert.equal(state.connection, undefined);
  assert.equal(state.message, 'The database server refused the connection.');
  assert.equal(harness.clients[0]?.endCalls, 1);
  assert.deepEqual(states, ['CONNECTING', 'CONNECTED', 'ERROR']);
});

test('an unexpected Client end event clears the active connection without crashing', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);

  assert.doesNotThrow(() => harness.clients[0]?.emitEnd());
  const state = harness.manager.getConnectionState();
  assert.equal(state.status, 'ERROR');
  assert.equal(state.connection, undefined);
  assert.equal(state.message, 'The PostgreSQL connection was closed unexpectedly.');
  assert.equal(harness.clients[0]?.endCalls, 1);
});

test('connection errors are classified without returning raw details', () => {
  const secret = 'never-return-this-password';
  const cases: Array<[Error & { code?: string }, string]> = [
    [Object.assign(new Error(`authentication failed ${secret}`), { code: '28P01' }), 'Authentication failed. Check the username and password.'],
    [Object.assign(new Error('database missing'), { code: '3D000' }), 'The specified database does not exist.'],
    [Object.assign(new Error('dns failed'), { code: 'ENOTFOUND' }), 'The database host could not be resolved.'],
    [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'The database server refused the connection.'],
    [Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'The database server did not respond before the connection timeout.'],
    [Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }), 'The database server is unreachable.'],
    [new Error(`unknown failure ${secret}`), 'PostgreSQL connection failed. Check the connection settings and server availability.'],
  ];

  for (const [error, expected] of cases) {
    const safeMessage = getSafeConnectionError(error);
    assert.equal(safeMessage, expected);
    assert.equal(safeMessage.includes(secret), false);
  }
});

test('shutdown closes an active Client once and blocks future connections', async () => {
  const harness = createHarness();
  await harness.manager.connect(temporaryRequest);
  await harness.manager.shutdown();

  assert.equal(harness.clients[0]?.endCalls, 1);
  assert.equal(harness.manager.getConnectionState().status, 'DISCONNECTED');
  await assert.rejects(() => harness.manager.connect(temporaryRequest), ConnectionManagerError);
});

test('shutdown closes an in-flight Test Connection Client once', async () => {
  const deferred = createDeferred<void>();
  const client = new FakePostgresClient();
  client.connectImplementation = () => deferred.promise;
  const manager = new PostgresConnectionManager(
    () => client,
    new FakeProfileProvider(),
    new FakeCredentialStorage(),
  );

  const testOperation = manager.testConnection(temporaryRequest);
  await manager.shutdown();
  assert.equal(client.endCalls, 1);
  deferred.resolve();
  await assert.rejects(testOperation, ConnectionManagerError);
  assert.equal(client.endCalls, 1);
});

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
