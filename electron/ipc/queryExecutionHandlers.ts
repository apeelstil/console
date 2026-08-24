import { ipcMain } from 'electron';
import {
  QUERY_EXECUTION_CHANNELS,
  type QueryExecutionResponse,
} from '../../shared/queryExecution';
import {
  PostgresQueryExecutionService,
  QueryExecutionError,
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
}

async function execute(
  getService: QueryExecutionServiceProvider,
  sql: unknown,
): Promise<QueryExecutionResponse> {
  if (typeof sql !== 'string') {
    return { ok: false, error: { kind: 'NOT_ALLOWED', message: 'SQL must be a string.' } };
  }

  const service = getService();
  if (!service) {
    return {
      ok: false,
      error: { kind: 'EXECUTION', message: 'SELECT execution is unavailable.' },
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
      error: { kind: 'EXECUTION', message: 'The SELECT query could not be executed.' },
    };
  }
}
