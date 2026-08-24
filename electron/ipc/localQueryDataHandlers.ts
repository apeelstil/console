import { ipcMain } from 'electron';
import {
  LOCAL_QUERY_DATA_CHANNELS,
  type CreateSavedQueryInput,
  type UpdateSavedQueryInput,
} from '../../shared/localQueryData';
import type { IpcResult } from '../../shared/connectionProfiles';
import { USER_MESSAGES } from '../../shared/userMessages';
import type { LocalQueryActivityService } from '../storage/queryActivityService';
import { SavedQueryService, SavedQueryServiceError } from '../storage/savedQueryService';

type SavedQueryServiceProvider = () => SavedQueryService | undefined;
type ActivityServiceProvider = () => LocalQueryActivityService | undefined;

export function registerLocalQueryDataHandlers(
  getSavedQueries: SavedQueryServiceProvider,
  getActivity: ActivityServiceProvider,
): void {
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.listSavedQueries, () =>
    respondSaved(getSavedQueries, (service) => service.listQueries()));
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.createSavedQuery, (_event, input: unknown) =>
    respondSaved(getSavedQueries, (service) => service.createQuery(parseCreateInput(input))));
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.updateSavedQuery, (_event, input: unknown) =>
    respondSaved(getSavedQueries, (service) => service.updateQuery(parseUpdateInput(input))));
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.deleteSavedQuery, (_event, id: unknown) =>
    respondSaved(getSavedQueries, (service) => {
      const parsedId = parseId(id);
      service.deleteQuery(parsedId);
      return { id: parsedId };
    }));

  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.listQueryHistory, () =>
    respondActivity(getActivity, (service) => service.listHistory()));
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.listAuditLog, () =>
    respondActivity(getActivity, (service) => service.listAuditLog()));
}

function respondSaved<T>(
  getService: SavedQueryServiceProvider,
  operation: (service: SavedQueryService) => T,
): IpcResult<T> {
  try {
    const service = getService();
    if (!service) return { ok: false, error: USER_MESSAGES.savedQueryStorageUnavailable };
    return { ok: true, data: operation(service) };
  } catch (error: unknown) {
    if (error instanceof SavedQueryServiceError) return { ok: false, error: error.safeMessage };
    return { ok: false, error: 'Не удалось завершить операцию с сохранённым запросом.' };
  }
}

function respondActivity<T>(
  getService: ActivityServiceProvider,
  operation: (service: LocalQueryActivityService) => T,
): IpcResult<T> {
  try {
    const service = getService();
    if (!service) return { ok: false, error: USER_MESSAGES.queryActivityStorageUnavailable };
    return { ok: true, data: operation(service) };
  } catch {
    return { ok: false, error: 'Не удалось прочитать локальную историю запросов.' };
  }
}

function parseCreateInput(value: unknown): CreateSavedQueryInput {
  const record = parseRecord(value);
  const description = record.description;
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw invalidInput();
  }
  return {
    name: parseString(record.name),
    description: description ?? null,
    sqlText: parseString(record.sqlText),
  };
}

function parseUpdateInput(value: unknown): UpdateSavedQueryInput {
  const record = parseRecord(value);
  return { id: parseId(record.id), ...parseCreateInput(record) };
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

function invalidInput(): SavedQueryServiceError {
  return new SavedQueryServiceError('Некорректные данные сохранённого запроса.');
}
