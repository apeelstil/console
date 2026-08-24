import type {
  QueryCellValue,
  QueryExecutionErrorDto,
  QueryResultColumn,
  SelectQueryResult,
} from '../../shared/queryExecution';
import type { ConnectionState } from '../../shared/postgresConnection';
import type {
  QueryActivityAttempt,
  QueryActivityRecorder,
} from '../storage/queryActivityService';
import { PostgresOperationBlockedError } from './postgresOperationGate';
import {
  ConnectionManagerError,
  type PostgresClient,
  type PostgresQueryResult,
} from './postgresConnectionManager';
import {
  SqlSafetyError,
  type SafeSelectQuery,
  type SqlSafetyService,
} from './sqlSafetyService';

const BEGIN_READ_ONLY_SQL = 'BEGIN READ ONLY;';
const SET_LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout = '15000ms';";
const ROLLBACK_SQL = 'ROLLBACK;';
const MAX_RESULT_ROWS = 1_000;

export interface ExclusiveActiveClientProvider {
  withActiveClient<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T>;
  getConnectionState(): ConnectionState;
}

export interface SelectSafetyValidator {
  validateSelect(sql: string): Promise<SafeSelectQuery>;
}

export class QueryExecutionError extends Error {
  constructor(public readonly details: QueryExecutionErrorDto) {
    super(details.message);
    this.name = 'QueryExecutionError';
  }
}

export class PostgresQueryExecutionService {
  private executionInProgress = false;

  constructor(
    private readonly connectionManager: ExclusiveActiveClientProvider,
    private readonly safetyService: SelectSafetyValidator | SqlSafetyService,
    private readonly activityRecorder: QueryActivityRecorder,
  ) {}

  async executeSelect(sql: string): Promise<SelectQueryResult> {
    if (this.executionInProgress) {
      const details: QueryExecutionErrorDto = {
        kind: 'EXECUTION',
        message: 'A query is already executing.',
      };
      const storageWarnings = await this.recordAttempt({
        sqlText: sql,
        connection: this.connectionManager.getConnectionState().connection,
        status: 'BLOCKED',
        durationMs: 0,
        returnedRows: null,
        truncated: false,
        errorCode: null,
        errorMessage: details.message,
      });
      throw new QueryExecutionError(withStorageWarnings(details, storageWarnings));
    }
    this.executionInProgress = true;
    const startedAt = Date.now();
    const connection = this.connectionManager.getConnectionState().connection;

    try {
      const safeQuery = await this.safetyService.validateSelect(sql);
      const result = await this.connectionManager.withActiveClient(async (client) => {
        const result = await executeReadOnlyTransaction(client, safeQuery.executableSql);
        return normalizeResult(result, Date.now() - startedAt);
      });
      const storageWarnings = await this.recordAttempt({
        sqlText: sql,
        connection,
        status: 'SUCCESS',
        durationMs: result.durationMs,
        returnedRows: result.returnedRows,
        truncated: result.truncated,
        errorCode: null,
        errorMessage: null,
      });
      return withStorageWarnings(result, storageWarnings);
    } catch (error: unknown) {
      const details = getSafeQueryError(error);
      const storageWarnings = await this.recordAttempt({
        sqlText: sql,
        connection,
        status: details.kind === 'NOT_ALLOWED'
          ? 'BLOCKED'
          : details.kind === 'TIMEOUT'
            ? 'TIMEOUT'
            : 'ERROR',
        durationMs: Math.max(0, Date.now() - startedAt),
        returnedRows: null,
        truncated: false,
        errorCode: details.sqlState ?? null,
        errorMessage: details.message,
      });
      throw new QueryExecutionError(withStorageWarnings(details, storageWarnings));
    } finally {
      this.executionInProgress = false;
    }
  }

  private async recordAttempt(attempt: QueryActivityAttempt): Promise<string[]> {
    try {
      return (await this.activityRecorder.recordAttempt(attempt)).warnings;
    } catch {
      const warning = 'Query activity storage is unavailable.';
      console.error(`[SUPRA] ${warning}`);
      return [warning];
    }
  }
}

async function executeReadOnlyTransaction(
  client: PostgresClient,
  executableSql: string,
): Promise<PostgresQueryResult> {
  let transactionStarted = false;
  let result: PostgresQueryResult | undefined;
  let operationError: unknown;

  try {
    await client.query(BEGIN_READ_ONLY_SQL);
    transactionStarted = true;
    await client.query(SET_LOCAL_TIMEOUT_SQL);
    result = await client.query({ text: executableSql, rowMode: 'array' });
  } catch (error: unknown) {
    operationError = error;
  } finally {
    if (transactionStarted) {
      try {
        await client.query(ROLLBACK_SQL);
      } catch (rollbackError: unknown) {
        if (operationError === undefined) operationError = rollbackError;
      }
    }
  }

  if (operationError !== undefined) throw operationError;
  if (!result) throw new Error('Query returned no result.');
  return result;
}

function normalizeResult(result: PostgresQueryResult, durationMs: number): SelectQueryResult {
  const sourceRows = result.rows.slice(0, MAX_RESULT_ROWS);
  const columns = normalizeColumns(result, sourceRows);
  const rows = sourceRows.map((row) => normalizeRow(row, columns));
  return {
    columns,
    rows,
    returnedRows: rows.length,
    truncated: result.rows.length > MAX_RESULT_ROWS,
    durationMs: Math.max(0, durationMs),
  };
}

function normalizeColumns(
  result: PostgresQueryResult,
  rows: unknown[],
): QueryResultColumn[] {
  if (result.fields && result.fields.length > 0) {
    return result.fields.map((field) => ({
      name: field.name,
      ...(Number.isSafeInteger(field.dataTypeID) ? { dataTypeId: field.dataTypeID } : {}),
    }));
  }

  const firstRow = rows[0];
  if (Array.isArray(firstRow)) {
    return firstRow.map((_value, index) => ({ name: `column_${index + 1}` }));
  }
  if (isRecord(firstRow)) return Object.keys(firstRow).map((name) => ({ name }));
  return [];
}

function normalizeRow(row: unknown, columns: QueryResultColumn[]): QueryCellValue[] {
  if (Array.isArray(row)) return columns.map((_column, index) => normalizeValue(row[index]));
  if (isRecord(row)) return columns.map((column) => normalizeValue(row[column.name]));
  return columns.map(() => null);
}

export function normalizeValue(value: unknown): QueryCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid date' : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;

  if (typeof value === 'object') {
    try {
      const seen = new WeakSet<object>();
      const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
        if (typeof nestedValue === 'bigint') return nestedValue.toString();
        if (typeof nestedValue === 'object' && nestedValue !== null) {
          if (seen.has(nestedValue)) return '[Circular]';
          seen.add(nestedValue);
        }
        return nestedValue;
      });
      return serialized ?? String(value);
    } catch {
      return 'Unserializable value';
    }
  }

  return String(value);
}

interface QueryErrorShape {
  code?: unknown;
  message?: unknown;
  position?: unknown;
}

export function getSafeQueryError(error: unknown): QueryExecutionErrorDto {
  if (error instanceof QueryExecutionError) return error.details;
  if (error instanceof SqlSafetyError) return error.details;
  if (error instanceof ConnectionManagerError) {
    return { kind: 'CONNECTION', message: error.safeMessage };
  }
  if (error instanceof PostgresOperationBlockedError) {
    return { kind: 'EXECUTION', message: error.safeMessage };
  }

  const details = isRecord(error) ? error as QueryErrorShape : {};
  const code = typeof details.code === 'string' && details.code.length === 5
    ? details.code
    : undefined;
  const position = typeof details.position === 'string'
    ? Number(details.position)
    : details.position;
  const safePosition = typeof position === 'number'
    && Number.isSafeInteger(position)
    && position >= 0
    ? position
    : undefined;

  if (code === '57014') {
    return { kind: 'TIMEOUT', message: 'The query exceeded the 15 second timeout.', sqlState: code };
  }
  if (code === '42501') {
    return { kind: 'PERMISSION_DENIED', message: 'Permission denied while executing the SELECT query.', sqlState: code };
  }
  if (code === '42601') {
    return {
      kind: 'SYNTAX',
      message: 'The PostgreSQL server rejected the query syntax.',
      sqlState: code,
      ...(safePosition !== undefined ? { position: safePosition } : {}),
    };
  }
  return {
    kind: 'EXECUTION',
    message: 'The SELECT query could not be executed.',
    ...(code ? { sqlState: code } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function withStorageWarnings<T extends object>(value: T, warnings: string[]): T & { storageWarnings?: string[] } {
  return warnings.length > 0 ? { ...value, storageWarnings: warnings } : value;
}
