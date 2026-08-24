import { ipcMain } from 'electron';
import {
  QUERY_EXECUTION_CHANNELS,
  type QueryExecutionResponse,
  type QueryOperationState,
} from '../../shared/queryExecution';
import type { IpcResult } from '../../shared/connectionProfiles';
import { USER_MESSAGES } from '../../shared/userMessages';
import {
  PostgresQueryExecutionService,
  QueryExecutionError,
  QueryOperationError,
} from '../postgres/postgresQueryExecutionService';
import { SqlSafetyError } from '../postgres/sqlSafetyService';

type QueryExecutionServiceProvider = () => PostgresQueryExecutionService | undefined;

export function registerQueryExecutionHandlers(
  getService: QueryExecutionServiceProvider,
): void {
  ipcMain.handle(
    QUERY_EXECUTION_CHANNELS.executeSelect,
    (_event, sql: unknown): Promise<QueryExecutionResponse> => execute(getService, sql),
  );
  ipcMain.handle(
    QUERY_EXECUTION_CHANNELS.cancelSelect,
    (_event, operationId: unknown): Promise<IpcResult<QueryOperationState>> =>
      cancel(getService, operationId),
  );
  ipcMain.handle(
    QUERY_EXECUTION_CHANNELS.getState,
    (): IpcResult<QueryOperationState> => {
      const service = getService();
      return service
        ? { ok: true, data: service.getState() }
        : { ok: false, error: USER_MESSAGES.queryExecutionUnavailable };
    },
  );
}

async function execute(
  getService: QueryExecutionServiceProvider,
  sql: unknown,
): Promise<QueryExecutionResponse> {
  if (typeof sql !== 'string') {
    return { ok: false, error: { kind: 'NOT_ALLOWED', message: 'SQL должен быть строкой.' } };
  }

  const service = getService();
  if (!service) {
    return {
      ok: false,
      error: { kind: 'EXECUTION', message: USER_MESSAGES.queryExecutionUnavailable },
    };
  }

  try {
    return { ok: true, data: await service.executeSelect(sql) };
  } catch (error: unknown) {
    if (error instanceof SqlSafetyError || error instanceof QueryExecutionError) {
      return { ok: false, error: error.details };
    }
    return {
      ok: false,
      error: { kind: 'EXECUTION', message: 'Не удалось выполнить запрос SELECT.' },
    };
  }
}

async function cancel(
  getService: QueryExecutionServiceProvider,
  operationId: unknown,
): Promise<IpcResult<QueryOperationState>> {
  if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 100) {
    return { ok: false, error: 'Некорректный идентификатор операции SELECT.' };
  }
  const service = getService();
  if (!service) return { ok: false, error: 'Отмена SELECT недоступна.' };

  try {
    return { ok: true, data: await service.cancelSelect(operationId) };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof QueryOperationError
        ? error.safeMessage
        : 'Не удалось отправить запрос отмены SELECT.',
    };
  }
}
