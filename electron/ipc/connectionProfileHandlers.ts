import { ipcMain } from 'electron';
import {
  CONNECTION_PROFILE_CHANNELS,
  isConnectionEnvironment,
  type ConnectionProfileFields,
  type CreateConnectionProfileInput,
  type IpcResult,
  type PasswordUpdate,
  type UpdateConnectionProfileInput,
} from '../../shared/connectionProfiles';
import { USER_MESSAGES } from '../../shared/userMessages';
import { ConnectionProfileService, ProfileServiceError } from '../storage/connectionProfileService';

type ProfileServiceProvider = () => ConnectionProfileService | undefined;

export function registerConnectionProfileHandlers(getService: ProfileServiceProvider): void {
  ipcMain.handle(CONNECTION_PROFILE_CHANNELS.list, () =>
    respond(getService, (service) => service.listProfiles()));

  ipcMain.handle(CONNECTION_PROFILE_CHANNELS.create, (_event, input: unknown) =>
    respond(getService, (service) => service.createProfile(parseCreateInput(input))));

  ipcMain.handle(CONNECTION_PROFILE_CHANNELS.update, (_event, input: unknown) =>
    respond(getService, (service) => service.updateProfile(parseUpdateInput(input))));

  ipcMain.handle(CONNECTION_PROFILE_CHANNELS.delete, (_event, id: unknown) =>
    respond(getService, (service) => {
      const parsedId = parseId(id);
      service.deleteProfile(parsedId);
      return { id: parsedId };
    }));
}

function respond<T>(
  getService: ProfileServiceProvider,
  operation: (service: ConnectionProfileService) => T,
): IpcResult<T> {
  try {
    const service = getService();
    if (!service) return { ok: false, error: USER_MESSAGES.localProfileStorageUnavailable };
    return { ok: true, data: operation(service) };
  } catch (error: unknown) {
    if (error instanceof ProfileServiceError) return { ok: false, error: error.safeMessage };
    return { ok: false, error: 'Не удалось завершить операцию с локальным профилем.' };
  }
}

function parseCreateInput(value: unknown): CreateConnectionProfileInput {
  const record = parseRecord(value);
  return {
    ...parseFields(record),
    password: parseString(record.password),
    savePasswordSecurely: parseBoolean(record.savePasswordSecurely),
  };
}

function parseUpdateInput(value: unknown): UpdateConnectionProfileInput {
  const record = parseRecord(value);
  return {
    id: parseId(record.id),
    ...parseFields(record),
    passwordUpdate: parsePasswordUpdate(record.passwordUpdate),
  };
}

function parseFields(record: Record<string, unknown>): ConnectionProfileFields {
  const environment = record.environment;
  if (!isConnectionEnvironment(environment)) throw invalidInput();

  return {
    name: parseString(record.name),
    host: parseString(record.host),
    port: parseNumber(record.port),
    database: parseString(record.database),
    username: parseString(record.username),
    environment,
  };
}

function parsePasswordUpdate(value: unknown): PasswordUpdate {
  const record = parseRecord(value);
  if (record.mode === 'keep' || record.mode === 'remove') return { mode: record.mode };
  if (record.mode === 'replace') return { mode: 'replace', password: parseString(record.password) };
  throw invalidInput();
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidInput();
  }
  return value;
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

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidInput();
  return value;
}

function invalidInput(): ProfileServiceError {
  return new ProfileServiceError('Некорректные данные профиля подключения.');
}
