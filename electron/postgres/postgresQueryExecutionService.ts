import { randomUUID } from 'node:crypto';
import type {
  QueryCellValue,
  QueryExecutionErrorDto,
  QueryOperationState,
  QueryResultColumn,
  SelectQueryResult,
} from '../../shared/queryExecution';
import type { ConnectionState } from '../../shared/postgresConnection';
import type {
  QueryActivityAttempt,
  QueryActivityRecorder,
} from '../storage/queryActivityService';
import type { ActiveClientAccess } from './postgresConnectionManager';
import {
  PostgresOperationBlockedError,
  PostgresOperationGate,
} from './postgresOperationGate';
import {
  ConnectionManagerError,
  type PostgresClient,
  type PostgresQueryConfig,
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
const DISCONNECT_QUERY_CLEANUP_TIMEOUT_MS = 22_000;

export interface ExclusiveActiveClientProvider {
  withActiveClient<T>(
    operation: (client: PostgresClient) => Promise<T>,
    access?: ActiveClientAccess,
  ): Promise<T>;
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

export class QueryOperationError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'QueryOperationError';
  }
}

export interface CancellableSelectQuery {
  result: Promise<PostgresQueryResult>;
  requestCancel(): Promise<void>;
}

export interface SelectQueryRunner {
  start(client: PostgresClient, config: PostgresQueryConfig): CancellableSelectQuery;
}

interface ActiveExecution {
  operationId: string;
  startedAt: string;
  cancelRequested: boolean;
  cancelRequestSent: boolean;
  phase: 'PREPARING' | 'RUNNING' | 'CLEANUP';
  runningQuery?: CancellableSelectQuery;
  completion: Promise<void>;
  complete(): void;
}

type QueryOperationStateListener = (state: QueryOperationState) => void;

class QueryCancelledBeforeDispatchError extends Error {}

const standardSelectQueryRunner: SelectQueryRunner = {
  start: (client, config) => ({
    result: client.query(config),
    requestCancel: () => Promise.reject(new Error('PostgreSQL cancellation is unavailable.')),
  }),
};

export class PostgresQueryExecutionService {
  private state: QueryOperationState = { status: 'IDLE' };
  private activeExecution: ActiveExecution | undefined;
  private readonly listeners = new Set<QueryOperationStateListener>();

  constructor(
    private readonly connectionManager: ExclusiveActiveClientProvider,
    private readonly safetyService: SelectSafetyValidator | SqlSafetyService,
    private readonly activityRecorder: QueryActivityRecorder,
    private readonly operationGate: PostgresOperationGate = new PostgresOperationGate(),
    private readonly queryRunner: SelectQueryRunner = standardSelectQueryRunner,
  ) {}

  getState(): QueryOperationState {
    return cloneOperationState(this.state);
  }

  subscribe(listener: QueryOperationStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async executeSelect(sql: string): Promise<SelectQueryResult> {
    if (this.activeExecution) {
      throw await this.recordBlockedExecution(sql, 'A query is already executing.');
    }

    const operationId = randomUUID();
    try {
      this.operationGate.reserveForSelect(operationId);
    } catch (error: unknown) {
      const message = error instanceof PostgresOperationBlockedError
        ? error.safeMessage
        : 'Another PostgreSQL operation is already in progress.';
      throw await this.recordBlockedExecution(sql, message);
    }

    const activeExecution = createActiveExecution(operationId);
    this.activeExecution = activeExecution;
    this.setState({
      status: 'EXECUTING',
      operationId,
      startedAt: activeExecution.startedAt,
    });
    const startedAt = Date.now();
    const connection = this.connectionManager.getConnectionState().connection;
    let resolutionMessage: string | undefined;

    try {
      const safeQuery = await this.safetyService.validateSelect(sql);
      throwIfCancelledBeforeDispatch(activeExecution);
      const result = await this.connectionManager.withActiveClient(async (client) => {
        const result = await executeReadOnlyTransaction(
          client,
          safeQuery.executableSql,
          activeExecution,
          this.queryRunner,
        );
        return normalizeResult(result, Date.now() - startedAt);
      }, { selectOperationId: operationId });
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
      const details = getExecutionError(error, activeExecution);
      resolutionMessage = operationResolutionMessage(details.kind);
      const storageWarnings = await this.recordAttempt({
        sqlText: sql,
        connection,
        status: details.kind === 'NOT_ALLOWED'
          ? 'BLOCKED'
          : details.kind === 'CANCELLED'
            ? 'CANCELLED'
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
      this.operationGate.releaseSelect(operationId);
      if (this.activeExecution === activeExecution) this.activeExecution = undefined;
      activeExecution.complete();
      this.setState({
        status: 'IDLE',
        ...(resolutionMessage ? { message: resolutionMessage } : {}),
      });
    }
  }

  async cancelSelect(operationId: string): Promise<QueryOperationState> {
    const activeExecution = this.activeExecution;
    if (!activeExecution || activeExecution.operationId !== operationId) {
      throw new QueryOperationError('No matching SELECT query is executing.');
    }
    if (activeExecution.phase === 'CLEANUP') {
      throw new QueryOperationError('The SELECT query has already finished; cleanup is in progress.');
    }
    if (activeExecution.cancelRequested) {
      throw new QueryOperationError('Query cancellation is already in progress.');
    }

    activeExecution.cancelRequested = true;
    this.setState({
      status: 'CANCELLING',
      operationId,
      startedAt: activeExecution.startedAt,
    });

    const runningQuery = activeExecution.runningQuery;
    if (runningQuery) {
      try {
        await runningQuery.requestCancel();
        activeExecution.cancelRequestSent = true;
      } catch {
        if (this.activeExecution !== activeExecution
          || activeExecution.runningQuery !== runningQuery) return this.getState();
        activeExecution.cancelRequested = false;
        this.setState({
          status: 'EXECUTING',
          operationId,
          startedAt: activeExecution.startedAt,
        });
        throw new QueryOperationError(
          'The cancellation request could not be sent. The query may still be running.',
        );
      }
    }

    return this.getState();
  }

  async cancelBeforeDisconnect(): Promise<void> {
    const activeExecution = this.activeExecution;
    if (!activeExecution) return;
    if (!activeExecution.cancelRequested && activeExecution.phase !== 'CLEANUP') {
      await this.cancelSelect(activeExecution.operationId).catch(() => undefined);
    }
    await waitForCompletion(activeExecution.completion, DISCONNECT_QUERY_CLEANUP_TIMEOUT_MS);
  }

  private async recordBlockedExecution(sql: string, message: string): Promise<QueryExecutionError> {
    const details: QueryExecutionErrorDto = { kind: 'EXECUTION', message };
    const storageWarnings = await this.recordAttempt({
      sqlText: sql,
      connection: this.connectionManager.getConnectionState().connection,
      status: 'BLOCKED',
      durationMs: 0,
      returnedRows: null,
      truncated: false,
      errorCode: null,
      errorMessage: message,
    });
    return new QueryExecutionError(withStorageWarnings(details, storageWarnings));
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

  private setState(state: QueryOperationState): void {
    this.state = cloneOperationState(state);
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        // Renderer notification failures must not affect PostgreSQL cleanup.
      }
    }
  }
}

async function executeReadOnlyTransaction(
  client: PostgresClient,
  executableSql: string,
  activeExecution: ActiveExecution,
  queryRunner: SelectQueryRunner,
): Promise<PostgresQueryResult> {
  let transactionStarted = false;
  let result: PostgresQueryResult | undefined;
  let operationError: unknown;

  try {
    await client.query(BEGIN_READ_ONLY_SQL);
    transactionStarted = true;
    throwIfCancelledBeforeDispatch(activeExecution);
    await client.query(SET_LOCAL_TIMEOUT_SQL);
    throwIfCancelledBeforeDispatch(activeExecution);
    activeExecution.phase = 'RUNNING';
    const runningQuery = queryRunner.start(client, { text: executableSql, rowMode: 'array' });
    activeExecution.runningQuery = runningQuery;
    result = await runningQuery.result;
  } catch (error: unknown) {
    operationError = error;
  } finally {
    activeExecution.phase = 'CLEANUP';
    activeExecution.runningQuery = undefined;
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

function throwIfCancelledBeforeDispatch(activeExecution: ActiveExecution): void {
  if (activeExecution.cancelRequested) throw new QueryCancelledBeforeDispatchError();
}

function createActiveExecution(operationId: string): ActiveExecution {
  let complete: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  return {
    operationId,
    startedAt: new Date().toISOString(),
    cancelRequested: false,
    cancelRequestSent: false,
    phase: 'PREPARING',
    completion,
    complete,
  };
}

function getExecutionError(
  error: unknown,
  activeExecution: ActiveExecution,
): QueryExecutionErrorDto {
  if (error instanceof QueryCancelledBeforeDispatchError
    || (activeExecution.cancelRequestSent && getSqlState(error) === '57014')) {
    return {
      kind: 'CANCELLED',
      message: 'Query cancelled',
      ...(getSqlState(error) ? { sqlState: getSqlState(error) } : {}),
    };
  }
  return getSafeQueryError(error);
}

function getSqlState(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' && error.code.length === 5 ? error.code : undefined;
}

function operationResolutionMessage(kind: QueryExecutionErrorDto['kind']): string | undefined {
  if (kind === 'CANCELLED') return 'Query cancelled';
  if (kind === 'TIMEOUT') return 'Query timed out';
  if (kind === 'CONNECTION') return 'Disconnected';
  return undefined;
}

function cloneOperationState(state: QueryOperationState): QueryOperationState {
  return { ...state };
}

async function waitForCompletion(completion: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([completion, timeout]);
  if (timer) clearTimeout(timer);
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
