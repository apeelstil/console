import { ipcMain } from 'electron';
import {
  isConnectionEnvironment,
  type ConnectionProfileFields,
  type IpcResult,
} from '../../shared/connectionProfiles';
import {
  POSTGRES_CONNECTION_CHANNELS,
  type ConnectionRequest,
} from '../../shared/postgresConnection';
import {
  ConnectionManagerError,
  type PostgresConnectionManager,
} from '../postgres/postgresConnectionManager';

type ConnectionManagerProvider = () => PostgresConnectionManager | undefined;

export function registerPostgresConnectionHandlers(getManager: ConnectionManagerProvider): void {
  ipcMain.handle(POSTGRES_CONNECTION_CHANNELS.test, (_event, request: unknown) =>
    respond(getManager, (manager) => manager.testConnection(parseConnectionRequest(request))));

  ipcMain.handle(POSTGRES_CONNECTION_CHANNELS.connect, (_event, request: unknown) =>
    respond(getManager, (manager) => manager.connect(parseConnectionRequest(request))));

  ipcMain.handle(POSTGRES_CONNECTION_CHANNELS.disconnect, () =>
    respond(getManager, (manager) => manager.disconnect()));

  ipcMain.handle(POSTGRES_CONNECTION_CHANNELS.getState, () =>
    respond(getManager, (manager) => manager.getConnectionState()));
}

async function respond<T>(
  getManager: ConnectionManagerProvider,
  operation: (manager: PostgresConnectionManager) => T | Promise<T>,
): Promise<IpcResult<T>> {
  try {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'PostgreSQL connection management is unavailable.' };
    return { ok: true, data: await operation(manager) };
  } catch (error: unknown) {
    if (error instanceof ConnectionManagerError) return { ok: false, error: error.safeMessage };
    return { ok: false, error: 'The PostgreSQL connection operation could not be completed.' };
  }
}

function parseConnectionRequest(value: unknown): ConnectionRequest {
  const record = parseRecord(value);
  if (record.source === 'profile') {
    return {
      source: 'profile',
      profileId: parseId(record.profileId),
      ...(record.temporaryPassword === undefined
        ? {}
        : { temporaryPassword: parseString(record.temporaryPassword) }),
    };
  }
  if (record.source === 'temporary') {
    return {
      source: 'temporary',
      connection: parseConnectionFields(record.connection),
      temporaryPassword: parseString(record.temporaryPassword),
    };
  }
  throw invalidInput();
}

function parseConnectionFields(value: unknown): ConnectionProfileFields {
  const record = parseRecord(value);
  if (!isConnectionEnvironment(record.environment)) throw invalidInput();
  return {
    name: parseString(record.name),
    host: parseString(record.host),
    port: parseNumber(record.port),
    database: parseString(record.database),
    username: parseString(record.username),
    environment: record.environment,
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidInput();
  return value as Record<string, unknown>;
}

function parseString(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput();
  return value;
}

function parseNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput();
  return value;
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidInput();
  }
  return value;
}

function invalidInput(): ConnectionManagerError {
  return new ConnectionManagerError('Invalid PostgreSQL connection data.');
}
