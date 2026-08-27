import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  LOCAL_QUERY_DATA_CHANNELS,
  type CreateSavedQueryInput,
  parseQueryActivityExportRequest,
  type QueryActivityExportRequest,
  type QueryActivityExportResult,
  type UpdateSavedQueryInput,
} from '../../shared/localQueryData';
import type { IpcResult } from '../../shared/connectionProfiles';
import { USER_MESSAGES } from '../../shared/userMessages';
import type { LocalQueryActivityService } from '../storage/queryActivityService';
import { SavedQueryService, SavedQueryServiceError } from '../storage/savedQueryService';
import { serializeAuditExport, serializeHistoryExport } from '../export/queryActivityExport';

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
  ipcMain.handle(LOCAL_QUERY_DATA_CHANNELS.exportQueryActivity, (event, input: unknown) =>
    exportQueryActivity(event, getActivity, input));
}

async function exportQueryActivity(
  event: IpcMainInvokeEvent,
  getService: ActivityServiceProvider,
  input: unknown,
): Promise<IpcResult<QueryActivityExportResult>> {
  try {
    const request = parseQueryActivityExportRequest(input);
    const service = getService();
    if (!service) return { ok: false, error: USER_MESSAGES.queryActivityStorageUnavailable };

    const { content, recordCount } = request.source === 'HISTORY'
      ? exportHistory(service, request)
      : exportAudit(service, request);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = createSaveDialogOptions(request);
    const selection = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) {
      return { ok: true, data: { status: 'CANCELLED' } };
    }

    await writeFile(selection.filePath, content, { encoding: 'utf8' });
    return { ok: true, data: { status: 'SAVED', recordCount } };
  } catch {
    return { ok: false, error: 'Не удалось экспортировать данные. Проверьте выбранный файл и повторите попытку.' };
  }
}

function exportHistory(
  service: LocalQueryActivityService,
  request: QueryActivityExportRequest,
): { content: string; recordCount: number } {
  const entries = service.listHistory();
  return {
    content: serializeHistoryExport(entries, request.format),
    recordCount: entries.length,
  };
}

function exportAudit(
  service: LocalQueryActivityService,
  request: QueryActivityExportRequest,
): { content: string; recordCount: number } {
  const entries = service.listAuditLog();
  return {
    content: serializeAuditExport(entries, request.format),
    recordCount: entries.length,
  };
}

function createSaveDialogOptions(request: QueryActivityExportRequest): Electron.SaveDialogOptions {
  const extension = request.format.toLowerCase();
  const sourceName = request.source === 'HISTORY' ? 'history' : 'audit';
  const date = new Date().toISOString().slice(0, 10);
  return {
    title: request.source === 'HISTORY' ? 'Экспорт истории запросов' : 'Экспорт журнала аудита',
    defaultPath: `supra-${sourceName}-${date}.${extension}`,
    buttonLabel: 'Сохранить',
    filters: [{ name: request.format, extensions: [extension] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
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
