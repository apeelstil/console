import { randomUUID } from 'node:crypto';
import type {
  MutationTransactionState,
  PendingMutationTransaction,
  PreparedMutation,
} from '../../shared/mutationTransaction';
import type { ActiveConnectionInfo, ConnectionState } from '../../shared/postgresConnection';
import type {
  MutationActivityRecorder,
  QueryActivityAttempt,
  QueryAuditEvent,
} from '../storage/queryActivityService';
import type {
  ActiveClientAccess,
  PostgresClient,
  PostgresQueryResult,
} from './postgresConnectionManager';
import { getSafeQueryError } from './postgresQueryExecutionService';
import {
  MutationSafetyError,
  type SafeMutationQuery,
} from './mutationSafetyService';
import {
  PostgresOperationBlockedError,
  PostgresOperationGate,
} from './postgresOperationGate';

const BEGIN_SQL = 'BEGIN;';
const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '15000ms';";
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5000ms';";
const COMMIT_SQL = 'COMMIT;';
const ROLLBACK_SQL = 'ROLLBACK;';
export const MUTATION_CONFIRMATION_TIMEOUT_MS = 120_000;

export interface MutationActiveClientProvider {
  getConnectionState(): ConnectionState;
  withActiveClient<T>(
    operation: (client: PostgresClient) => Promise<T>,
    access?: ActiveClientAccess,
  ): Promise<T>;
}

export interface MutationSafetyValidator {
  validateMutation(sql: string): Promise<SafeMutationQuery>;
}

export interface MutationTimerScheduler {
  set(callback: () => void | Promise<void>, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const systemTimerScheduler: MutationTimerScheduler = {
  set: (callback, delayMs) => setTimeout(() => { void callback(); }, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface StoredPreparation {
  publicValue: PreparedMutation;
  normalizedSql: string;
  connectionKey: string;
}

interface PendingContext {
  publicValue: PendingMutationTransaction;
  sqlText: string;
}

type StateListener = (state: MutationTransactionState) => void;

export class MutationTransactionError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'MutationTransactionError';
  }
}

export class MutationTransactionManager {
  private state: MutationTransactionState = { status: 'IDLE' };
  private preparation: StoredPreparation | undefined;
  private pending: PendingContext | undefined;
  private rollbackTimer: unknown;
  private readonly listeners = new Set<StateListener>();

  constructor(
    private readonly connectionManager: MutationActiveClientProvider,
    private readonly safetyService: MutationSafetyValidator,
    private readonly operationGate: PostgresOperationGate,
    private readonly activityRecorder: MutationActivityRecorder,
    private readonly timerScheduler: MutationTimerScheduler = systemTimerScheduler,
  ) {}

  getState(): MutationTransactionState {
    return cloneState(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prepareMutation(sql: string): Promise<PreparedMutation> {
    this.assertCanStartMutation();
    if (this.state.status === 'ERROR'
      || (this.state.status === 'IDLE' && this.state.message)) this.setState({ status: 'IDLE' });
    const connection = this.getConnectedTarget();

    let safeQuery: SafeMutationQuery;
    try {
      safeQuery = await this.safetyService.validateMutation(sql);
    } catch (error: unknown) {
      const details = error instanceof MutationSafetyError
        ? error.details
        : { message: 'The mutation could not be validated safely.', operation: 'MUTATION' as const };
      const warnings = await this.recordAttempt({
        sqlText: sql,
        connection,
        status: 'BLOCKED',
        durationMs: 0,
        returnedRows: null,
        truncated: false,
        errorCode: null,
        errorMessage: details.message,
        operation: details.operation,
      });
      throw new MutationTransactionError(withWarnings(details.message, warnings));
    }

    const storageWarnings = await this.recordAudit({
      sqlText: safeQuery.normalizedSql,
      connection,
      operation: safeQuery.operation,
      outcome: 'VALIDATED',
      durationMs: null,
      returnedRows: null,
      errorCode: null,
      errorMessage: null,
    });
    const publicValue: PreparedMutation = {
      preparationId: randomUUID(),
      operation: safeQuery.operation,
      target: safeQuery.target,
      sqlText: safeQuery.normalizedSql,
      connection,
      ...(storageWarnings.length > 0 ? { storageWarnings } : {}),
    };
    this.preparation = {
      publicValue,
      normalizedSql: safeQuery.normalizedSql,
      connectionKey: connectionKey(connection),
    };
    return clonePreparation(publicValue);
  }

  async executeMutation(preparationId: string): Promise<PendingMutationTransaction> {
    this.assertCanStartMutation();
    const preparation = this.preparation;
    if (!preparation || preparation.publicValue.preparationId !== preparationId) {
      throw new MutationTransactionError('The mutation confirmation is invalid or has expired.');
    }
    this.preparation = undefined;

    const connection = this.getConnectedTarget();
    if (connectionKey(connection) !== preparation.connectionKey) {
      throw new MutationTransactionError('The active database changed. Prepare the mutation again.');
    }

    let safeQuery: SafeMutationQuery;
    try {
      safeQuery = await this.safetyService.validateMutation(preparation.normalizedSql);
    } catch (error: unknown) {
      const message = error instanceof MutationSafetyError
        ? error.details.message
        : 'The mutation could not be revalidated safely.';
      const warnings = await this.recordAttempt({
        sqlText: preparation.normalizedSql,
        connection,
        status: 'BLOCKED',
        durationMs: 0,
        returnedRows: null,
        truncated: false,
        errorCode: null,
        errorMessage: message,
        operation: preparation.publicValue.operation,
      });
      throw new MutationTransactionError(withWarnings(message, warnings));
    }

    const transactionId = randomUUID();
    const startedAt = new Date().toISOString();
    this.operationGate.reserveForMutation(transactionId);
    this.setState({
      status: 'EXECUTING',
      transactionId,
      operation: safeQuery.operation,
      target: safeQuery.target,
      startedAt,
      connection,
    });
    const startedMs = Date.now();

    let result: PostgresQueryResult;
    try {
      result = await this.connectionManager.withActiveClient(
        (client) => executeStatement(client, safeQuery.normalizedSql),
        { mutationTransactionId: transactionId },
      );
    } catch (error: unknown) {
      this.operationGate.releaseMutation(transactionId);
      this.pending = undefined;
      const safeError = getSafeMutationError(error);
      const warnings = await this.recordAttempt({
        sqlText: safeQuery.normalizedSql,
        connection,
        status: safeError.kind === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
        durationMs: Math.max(0, Date.now() - startedMs),
        returnedRows: null,
        truncated: false,
        errorCode: safeError.sqlState ?? null,
        errorMessage: safeError.message,
        operation: safeQuery.operation,
      });
      this.setState({ status: 'ERROR', message: withWarnings(safeError.message, warnings) });
      throw new MutationTransactionError(withWarnings(safeError.message, warnings));
    }

    const affectedRows = normalizeAffectedRows(result);
    const durationMs = Math.max(0, Date.now() - startedMs);
    const publicValue: PendingMutationTransaction = {
      status: 'PENDING_CONFIRMATION',
      transactionId,
      operation: safeQuery.operation,
      target: safeQuery.target,
      affectedRows,
      startedAt,
      connection,
    };
    this.pending = { publicValue, sqlText: safeQuery.normalizedSql };
    this.setState(publicValue);
    this.startRollbackTimer(transactionId);

    const storageWarnings = await this.recordAttempt({
      sqlText: safeQuery.normalizedSql,
      connection,
      status: 'SUCCESS',
      durationMs,
      returnedRows: affectedRows,
      truncated: false,
      errorCode: null,
      errorMessage: null,
      operation: safeQuery.operation,
      auditOutcome: 'PENDING',
    });
    if (this.pending?.publicValue.transactionId !== transactionId) {
      throw new MutationTransactionError('The connection was lost and the mutation transaction was rolled back.');
    }
    if (storageWarnings.length > 0) {
      publicValue.storageWarnings = storageWarnings;
      this.pending = { publicValue, sqlText: safeQuery.normalizedSql };
      this.setState(publicValue);
    }
    return clonePending(publicValue);
  }

  async commit(transactionId: string): Promise<MutationTransactionState> {
    const pending = this.requirePending(transactionId);
    this.clearRollbackTimer();
    this.setState(toBusyState('COMMITTING', pending.publicValue));
    try {
      await this.connectionManager.withActiveClient(
        (client) => commitTransaction(client),
        { mutationTransactionId: transactionId },
      );
      const warnings = await this.recordAudit(transactionEvent(pending, 'COMMIT', 'COMMITTED'));
      this.finishTransaction(transactionId, `Changes committed${warningSuffix(warnings)}`);
      return this.getState();
    } catch (error: unknown) {
      const commitFailure = error instanceof CommitTransactionFailure ? error : undefined;
      const safeError = getSafeMutationError(commitFailure?.originalError ?? error);
      const warnings = await this.recordAudit({
        ...transactionEvent(pending, 'COMMIT', 'ERROR'),
        errorCode: safeError.sqlState ?? null,
        errorMessage: safeError.message,
      });
      if (commitFailure && !commitFailure.rollbackSucceeded
        && this.pending?.publicValue.transactionId === transactionId) {
        this.setState(pending.publicValue);
        this.startRollbackTimer(transactionId);
        throw new MutationTransactionError(withWarnings(
          'COMMIT failed and ROLLBACK could not be confirmed. The transaction remains pending.',
          warnings,
        ));
      }
      this.finishTransaction(transactionId, undefined, withWarnings(safeError.message, warnings));
      throw new MutationTransactionError(withWarnings(safeError.message, warnings));
    }
  }

  async rollback(transactionId: string): Promise<MutationTransactionState> {
    return this.performRollback(transactionId, 'MANUAL');
  }

  async rollbackBeforeDisconnect(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    await this.performRollback(pending.publicValue.transactionId, 'DISCONNECT');
  }

  async handleConnectionLoss(): Promise<void> {
    this.preparation = undefined;
    const pending = this.pending;
    if (!pending) return;
    const transactionId = pending.publicValue.transactionId;
    this.clearRollbackTimer();
    this.pending = undefined;
    this.operationGate.releaseMutation(transactionId);
    const warnings = await this.recordAudit(transactionEvent(pending, 'ROLLBACK', 'CONNECTION_LOST'));
    this.setState({
      status: 'IDLE',
      message: `Transaction rolled back because the connection was lost${warningSuffix(warnings)}`,
    });
  }

  private async performRollback(
    transactionId: string,
    source: 'MANUAL' | 'AUTO' | 'DISCONNECT',
  ): Promise<MutationTransactionState> {
    const pending = this.requirePending(transactionId);
    this.clearRollbackTimer();
    this.setState(toBusyState('ROLLING_BACK', pending.publicValue));
    try {
      await this.connectionManager.withActiveClient(
        (client) => client.query(ROLLBACK_SQL).then(() => undefined),
        { mutationTransactionId: transactionId },
      );
      const outcome = source === 'AUTO' ? 'AUTO_ROLLED_BACK' : 'ROLLED_BACK';
      const warnings = await this.recordAudit(transactionEvent(pending, 'ROLLBACK', outcome));
      const message = source === 'AUTO'
        ? 'Transaction automatically rolled back due to timeout'
        : source === 'DISCONNECT'
          ? 'Transaction rolled back before disconnect'
          : 'Changes rolled back';
      this.finishTransaction(transactionId, `${message}${warningSuffix(warnings)}`);
      return this.getState();
    } catch (error: unknown) {
      const safeError = getSafeMutationError(error);
      const warnings = await this.recordAudit({
        ...transactionEvent(pending, 'ROLLBACK', 'ERROR'),
        errorCode: safeError.sqlState ?? null,
        errorMessage: safeError.message,
      });
      this.pending = pending;
      this.setState(pending.publicValue);
      if (source === 'AUTO') this.startRollbackTimer(transactionId);
      throw new MutationTransactionError(withWarnings(safeError.message, warnings));
    }
  }

  private assertCanStartMutation(): void {
    try {
      this.operationGate.assertStandardOperationAllowed();
    } catch (error: unknown) {
      if (error instanceof PostgresOperationBlockedError) {
        throw new MutationTransactionError(error.safeMessage);
      }
      throw error;
    }
    if (this.state.status === 'EXECUTING'
      || this.state.status === 'COMMITTING'
      || this.state.status === 'ROLLING_BACK') {
      throw new MutationTransactionError('A mutation transaction operation is already in progress.');
    }
  }

  private getConnectedTarget(): ActiveConnectionInfo {
    const state = this.connectionManager.getConnectionState();
    if (state.status !== 'CONNECTED' || !state.connection) {
      throw new MutationTransactionError('Connect to a database before executing a mutation.');
    }
    return { ...state.connection };
  }

  private requirePending(transactionId: string): PendingContext {
    const pending = this.pending;
    if (!pending
      || this.state.status !== 'PENDING_CONFIRMATION'
      || pending.publicValue.transactionId !== transactionId) {
      throw new MutationTransactionError('No matching uncommitted mutation transaction exists.');
    }
    return pending;
  }

  private startRollbackTimer(transactionId: string): void {
    this.clearRollbackTimer();
    this.rollbackTimer = this.timerScheduler.set(async () => {
      await this.performRollback(transactionId, 'AUTO').catch(() => undefined);
    }, MUTATION_CONFIRMATION_TIMEOUT_MS);
  }

  private clearRollbackTimer(): void {
    if (this.rollbackTimer === undefined) return;
    this.timerScheduler.clear(this.rollbackTimer);
    this.rollbackTimer = undefined;
  }

  private finishTransaction(transactionId: string, message?: string, errorMessage?: string): void {
    this.clearRollbackTimer();
    this.pending = undefined;
    this.preparation = undefined;
    this.operationGate.releaseMutation(transactionId);
    this.setState(errorMessage
      ? { status: 'ERROR', message: errorMessage }
      : { status: 'IDLE', ...(message ? { message } : {}) });
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

  private async recordAudit(event: QueryAuditEvent): Promise<string[]> {
    try {
      return (await this.activityRecorder.recordAuditEvent(event)).warnings;
    } catch {
      const warning = 'Audit log storage is unavailable.';
      console.error(`[SUPRA] ${warning}`);
      return [warning];
    }
  }

  private setState(state: MutationTransactionState): void {
    this.state = cloneState(state);
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        // Renderer notification failures never affect transaction control.
      }
    }
  }
}

async function executeStatement(client: PostgresClient, sql: string): Promise<PostgresQueryResult> {
  let transactionStarted = false;
  try {
    await client.query(BEGIN_SQL);
    transactionStarted = true;
    await client.query(STATEMENT_TIMEOUT_SQL);
    await client.query(LOCK_TIMEOUT_SQL);
    return await client.query(sql);
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        await client.query(ROLLBACK_SQL);
      } catch {
        // The original safe execution error remains authoritative.
      }
    }
    throw error;
  }
}

async function commitTransaction(client: PostgresClient): Promise<void> {
  try {
    await client.query(COMMIT_SQL);
  } catch (error: unknown) {
    let rollbackSucceeded = false;
    try {
      await client.query(ROLLBACK_SQL);
      rollbackSucceeded = true;
    } catch {
      // Connection lifecycle handling will clear any uncertain server state.
    }
    throw new CommitTransactionFailure(error, rollbackSucceeded);
  }
}

class CommitTransactionFailure extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly rollbackSucceeded: boolean,
  ) {
    super('Commit transaction failed.');
    this.name = 'CommitTransactionFailure';
  }
}

function normalizeAffectedRows(result: PostgresQueryResult): number {
  return typeof result.rowCount === 'number' && Number.isSafeInteger(result.rowCount) && result.rowCount >= 0
    ? result.rowCount
    : 0;
}

function getSafeMutationError(error: unknown) {
  const code = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
  if (code === '23505') {
    return { kind: 'EXECUTION' as const, message: 'The mutation violates a unique constraint.', sqlState: code };
  }
  if (code === '23503') {
    return { kind: 'EXECUTION' as const, message: 'The mutation violates a foreign key constraint.', sqlState: code };
  }
  if (code === '23502') {
    return { kind: 'EXECUTION' as const, message: 'The mutation violates a required column constraint.', sqlState: code };
  }
  const safeError = getSafeQueryError(error);
  if (safeError.sqlState === '55P03') {
    return {
      kind: 'TIMEOUT' as const,
      message: 'The mutation could not acquire a database lock within 5 seconds.',
      sqlState: safeError.sqlState,
    };
  }
  if (safeError.kind === 'TIMEOUT') {
    return { ...safeError, message: 'The mutation exceeded the 15 second statement timeout.' };
  }
  if (safeError.kind === 'PERMISSION_DENIED') {
    return { ...safeError, message: 'Permission denied while executing the mutation.' };
  }
  if (safeError.kind === 'EXECUTION') {
    return { ...safeError, message: 'The INSERT or UPDATE statement could not be executed.' };
  }
  return safeError;
}

function connectionKey(connection: ActiveConnectionInfo): string {
  return JSON.stringify([
    connection.profileId ?? null,
    connection.host,
    connection.port,
    connection.database,
    connection.username,
    connection.environment,
  ]);
}

function transactionEvent(
  pending: PendingContext,
  operation: 'COMMIT' | 'ROLLBACK',
  outcome: QueryAuditEvent['outcome'],
): QueryAuditEvent {
  return {
    sqlText: pending.sqlText,
    connection: pending.publicValue.connection,
    operation,
    outcome,
    durationMs: Math.max(0, Date.now() - new Date(pending.publicValue.startedAt).getTime()),
    returnedRows: pending.publicValue.affectedRows,
    errorCode: null,
    errorMessage: null,
  };
}

function toBusyState(
  status: 'COMMITTING' | 'ROLLING_BACK',
  pending: PendingMutationTransaction,
): MutationTransactionState {
  return {
    status,
    transactionId: pending.transactionId,
    operation: pending.operation,
    target: pending.target,
    startedAt: pending.startedAt,
    connection: { ...pending.connection },
  };
}

function warningSuffix(warnings: string[]): string {
  return warnings.length > 0 ? ` · ${warnings.join(' ')}` : '';
}

function withWarnings(message: string, warnings: string[]): string {
  return warnings.length > 0 ? `${message} Storage warning: ${warnings.join(' ')}` : message;
}

function clonePreparation(preparation: PreparedMutation): PreparedMutation {
  return {
    ...preparation,
    target: { ...preparation.target },
    connection: { ...preparation.connection },
    ...(preparation.storageWarnings ? { storageWarnings: [...preparation.storageWarnings] } : {}),
  };
}

function clonePending(pending: PendingMutationTransaction): PendingMutationTransaction {
  return {
    ...pending,
    target: { ...pending.target },
    connection: { ...pending.connection },
    ...(pending.storageWarnings ? { storageWarnings: [...pending.storageWarnings] } : {}),
  };
}

function cloneState(state: MutationTransactionState): MutationTransactionState {
  if (state.status === 'IDLE' || state.status === 'ERROR') return { ...state };
  if (state.status === 'PENDING_CONFIRMATION') return clonePending(state);
  return { ...state, target: { ...state.target }, connection: { ...state.connection } };
}
