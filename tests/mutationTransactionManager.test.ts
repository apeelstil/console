import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionRequest, ConnectionState } from '../shared/postgresConnection';
import type {
  QueryActivityAttempt,
  QueryActivityRecordResult,
  QueryAuditEvent,
  MutationActivityRecorder,
} from '../electron/storage/queryActivityService';
import type { CredentialStorage } from '../electron/storage/credentialStorage';
import {
  MutationTransactionError,
  MutationTransactionManager,
  MUTATION_CONFIRMATION_TIMEOUT_MS,
  type MutationActiveClientProvider,
  type MutationSafetyValidator,
  type MutationTimerScheduler,
} from '../electron/postgres/mutationTransactionManager';
import type { SafeMutationQuery } from '../electron/postgres/mutationSafetyService';
import {
  PostgresConnectionManager,
  type ActiveClientAccess,
  type PostgresClient,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from '../electron/postgres/postgresConnectionManager';
import { PostgresOperationGate } from '../electron/postgres/postgresOperationGate';
import {
  PostgresQueryExecutionService,
  QueryExecutionError,
  type SelectQueryRunner,
} from '../electron/postgres/postgresQueryExecutionService';
import { PostgresMetadataService } from '../electron/postgres/postgresMetadataService';
import { MutationSafetyError } from '../electron/postgres/mutationSafetyService';

const normalizedUpdate = "UPDATE public.orders SET status = 'DONE' WHERE id = 7";
const safeUpdate: SafeMutationQuery = {
  operation: 'UPDATE',
  target: { schema: 'public', table: 'orders' },
  normalizedSql: normalizedUpdate,
};

const connectedState: ConnectionState = {
  status: 'CONNECTED',
  connection: {
    profileId: '4a479f24-079b-42dc-bc2c-91e21b8f3d92',
    name: 'SUPRA TEST',
    host: 'test-db',
    port: 5432,
    database: 'supra_test',
    username: 'support_user',
    environment: 'TEST',
  },
};

class FakeMutationClient implements PostgresClient {
  readonly requests: Array<string | PostgresQueryConfig> = [];
  readonly lifecycle: string[] = [];
  affectedRows = 3;
  failMutation?: Error & { code?: string };
  failCommit?: Error & { code?: string };
  failRollback?: Error & { code?: string };
  queryImplementation?: (request: string | PostgresQueryConfig) => Promise<PostgresQueryResult>;

  async connect(): Promise<void> { this.lifecycle.push('CONNECT'); }
  async query(request: string | PostgresQueryConfig): Promise<PostgresQueryResult> {
    this.requests.push(request);
    const text = typeof request === 'string' ? request : request.text;
    this.lifecycle.push(text);
    if (text === normalizedUpdate && this.failMutation) throw this.failMutation;
    if (text === 'COMMIT;' && this.failCommit) throw this.failCommit;
    if (text === 'ROLLBACK;' && this.failRollback) throw this.failRollback;
    if (this.queryImplementation) return this.queryImplementation(request);
    return { rows: [], rowCount: text === normalizedUpdate ? this.affectedRows : null };
  }
  async end(): Promise<void> { this.lifecycle.push('END'); }
  on(): this {
    return this;
  }
}

class GateAwareProvider implements MutationActiveClientProvider {
  state: ConnectionState = connectedState;
  constructor(readonly client: FakeMutationClient, private readonly gate: PostgresOperationGate) {}
  getConnectionState(): ConnectionState { return structuredClone(this.state); }
  async withActiveClient<T>(
    operation: (client: PostgresClient) => Promise<T>,
    access: ActiveClientAccess = {},
  ): Promise<T> {
    if (access.mutationTransactionId) this.gate.assertMutationOwner(access.mutationTransactionId);
    else if (access.selectOperationId) this.gate.assertSelectOwner(access.selectOperationId);
    else this.gate.assertStandardOperationAllowed();
    return operation(this.client);
  }
}

class FakeMutationSafety implements MutationSafetyValidator {
  calls = 0;
  error?: MutationSafetyError;
  result: SafeMutationQuery = safeUpdate;
  async validateMutation(): Promise<SafeMutationQuery> {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.result;
  }
}

class RecordingActivity implements MutationActivityRecorder {
  readonly attempts: QueryActivityAttempt[] = [];
  readonly auditEvents: QueryAuditEvent[] = [];
  async recordAttempt(attempt: QueryActivityAttempt): Promise<QueryActivityRecordResult> {
    this.attempts.push(attempt);
    return { warnings: [] };
  }
  async recordAuditEvent(event: QueryAuditEvent): Promise<QueryActivityRecordResult> {
    this.auditEvents.push(event);
    return { warnings: [] };
  }
}

class FakeTimer implements MutationTimerScheduler {
  callback?: () => void | Promise<void>;
  delayMs?: number;
  cleared = false;
  set(callback: () => void | Promise<void>, delayMs: number): number {
    this.callback = callback;
    this.delayMs = delayMs;
    this.cleared = false;
    return 1;
  }
  clear(): void { this.cleared = true; this.callback = undefined; }
  async fire(): Promise<void> {
    const callback = this.callback;
    this.callback = undefined;
    if (callback) await callback();
  }
}

test('10/11: successful mutation becomes PENDING without COMMIT and returns affectedRows', async () => {
  const harness = createHarness();
  const pending = await prepareAndExecute(harness);

  assert.equal(pending.status, 'PENDING_CONFIRMATION');
  assert.equal(pending.affectedRows, 3);
  assert.deepEqual(harness.client.requests, [
    'BEGIN;',
    "SET LOCAL statement_timeout = '15000ms';",
    "SET LOCAL lock_timeout = '5000ms';",
    normalizedUpdate,
  ]);
  assert.equal(harness.client.requests.includes('COMMIT;'), false);
  assert.equal(harness.manager.getState().status, 'PENDING_CONFIRMATION');
  assert.equal(harness.timer.delayMs, MUTATION_CONFIRMATION_TIMEOUT_MS);
});

test('12: COMMIT completes only the matching pending transaction and cannot be repeated', async () => {
  const harness = createHarness();
  const pending = await prepareAndExecute(harness);

  await assert.rejects(
    () => harness.manager.commit('ebbc44d7-56ab-463b-89a8-d3ed7c8cf5db'),
    MutationTransactionError,
  );
  assert.equal(harness.client.requests.includes('COMMIT;'), false);

  const state = await harness.manager.commit(pending.transactionId);

  assert.deepEqual(state, { status: 'IDLE', message: 'Изменения зафиксированы' });
  assert.equal(harness.client.requests.at(-1), 'COMMIT;');
  assert.equal(harness.timer.cleared, true);
  await assert.rejects(() => harness.manager.commit(pending.transactionId), MutationTransactionError);
});

test('13: ROLLBACK cancels the pending transaction and cannot be repeated', async () => {
  const harness = createHarness();
  const pending = await prepareAndExecute(harness);

  const state = await harness.manager.rollback(pending.transactionId);

  assert.deepEqual(state, { status: 'IDLE', message: 'Изменения отменены через ROLLBACK' });
  assert.equal(harness.client.requests.at(-1), 'ROLLBACK;');
  await assert.rejects(() => harness.manager.rollback(pending.transactionId), MutationTransactionError);
});

test('an unconfirmed COMMIT and fallback ROLLBACK keep the transaction exclusive', async () => {
  const harness = createHarness();
  const pending = await prepareAndExecute(harness);
  harness.client.failCommit = Object.assign(new Error('raw commit transport failure'), { code: 'ECONNRESET' });
  harness.client.failRollback = Object.assign(new Error('raw rollback transport failure'), { code: 'ECONNRESET' });

  await assert.rejects(
    () => harness.manager.commit(pending.transactionId),
    (error: unknown) => error instanceof MutationTransactionError
      && error.safeMessage.includes('Транзакция остаётся в ожидании')
      && !error.safeMessage.includes('raw'),
  );

  assert.equal(harness.manager.getState().status, 'PENDING_CONFIRMATION');
  assert.equal(harness.gate.hasPendingMutation(), true);
  harness.client.failRollback = undefined;
  await harness.manager.rollback(pending.transactionId);
  assert.equal(harness.gate.hasPendingMutation(), false);
});

test('14: statement error immediately ROLLBACKs and creates no pending transaction', async () => {
  const harness = createHarness();
  harness.client.failMutation = Object.assign(new Error('raw duplicate detail'), { code: '23505' });
  const prepared = await harness.manager.prepareMutation(normalizedUpdate);

  await assert.rejects(
    () => harness.manager.executeMutation(prepared.preparationId),
    (error: unknown) => error instanceof MutationTransactionError
      && error.safeMessage === 'Изменение нарушает ограничение уникальности.'
      && !error.safeMessage.includes('raw duplicate'),
  );

  assert.equal(harness.client.requests.at(-1), 'ROLLBACK;');
  assert.equal(harness.manager.getState().status, 'ERROR');
  assert.equal(harness.gate.hasPendingMutation(), false);
  assert.equal(harness.activity.attempts.at(-1)?.status, 'ERROR');
});

test('15: a second mutation is blocked while one transaction is pending', async () => {
  const harness = createHarness();
  await prepareAndExecute(harness);
  const requestCount = harness.client.requests.length;

  await assert.rejects(() => harness.manager.prepareMutation(normalizedUpdate), MutationTransactionError);

  assert.equal(harness.client.requests.length, requestCount);
  assert.equal(harness.safety.calls, 2);
});

test('16: SELECT and metadata are blocked by the main-process gate while pending', async () => {
  const harness = createHarness();
  await prepareAndExecute(harness);
  const selectService = new PostgresQueryExecutionService(
    harness.provider,
    { validateSelect: async () => ({ normalizedSql: 'SELECT 1', executableSql: 'SELECT 1' }) },
    harness.activity,
    harness.gate,
  );
  const metadataService = new PostgresMetadataService(harness.provider);

  await assert.rejects(() => selectService.executeSelect('SELECT 1'));
  await assert.rejects(() => metadataService.listSchemas());

  assert.equal(harness.client.requests.includes('SELECT 1'), false);
  assert.equal(harness.activity.attempts.at(-1)?.errorMessage?.includes('COMMIT или ROLLBACK'), true);
});

test('17: pending transaction automatically rolls back after 120 seconds', async () => {
  const harness = createHarness();
  await prepareAndExecute(harness);

  await harness.timer.fire();

  assert.equal(harness.client.requests.at(-1), 'ROLLBACK;');
  assert.deepEqual(harness.manager.getState(), {
    status: 'IDLE',
    message: 'Транзакция автоматически отменена через ROLLBACK по тайм-ауту',
  });
  assert.equal(harness.activity.auditEvents.at(-1)?.outcome, 'AUTO_ROLLED_BACK');
});

test('18: disconnect hook rolls back before the PostgreSQL client is closed', async () => {
  const harness = await createConnectionManagerHarness();
  await prepareAndExecute(harness);

  await harness.connectionManager.disconnect();

  assert.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
  assert.equal(harness.manager.getState().status, 'IDLE');
});

test('19: application shutdown uses the same rollback-before-close hook', async () => {
  const harness = await createConnectionManagerHarness();
  await prepareAndExecute(harness);

  await harness.connectionManager.shutdown();

  assert.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
  assert.equal(harness.manager.getState().status, 'IDLE');
});

test('20: connection loss clears local pending state and releases the gate', async () => {
  const harness = createHarness();
  await prepareAndExecute(harness);

  await harness.manager.handleConnectionLoss();

  assert.equal(harness.manager.getState().status, 'IDLE');
  assert.equal(harness.gate.hasPendingMutation(), false);
  assert.equal(harness.activity.auditEvents.at(-1)?.outcome, 'CONNECTION_LOST');
  await harness.provider.withActiveClient(async () => undefined);
});

test('21: Audit records UPDATE pending plus COMMIT and INSERT/UPDATE plus ROLLBACK operations', async () => {
  const commitHarness = createHarness();
  const committed = await prepareAndExecute(commitHarness);
  await commitHarness.manager.commit(committed.transactionId);
  assert.deepEqual(
    commitHarness.activity.auditEvents.map((event) => [event.operation, event.outcome]),
    [['UPDATE', 'VALIDATED'], ['COMMIT', 'COMMITTED']],
  );
  assert.equal(commitHarness.activity.attempts[0]?.operation, 'UPDATE');
  assert.equal(commitHarness.activity.attempts[0]?.auditOutcome, 'PENDING');

  const rollbackHarness = createHarness();
  const rolledBack = await prepareAndExecute(rollbackHarness);
  await rollbackHarness.manager.rollback(rolledBack.transactionId);
  assert.equal(rollbackHarness.activity.auditEvents.at(-1)?.operation, 'ROLLBACK');
  assert.equal(rollbackHarness.activity.auditEvents.at(-1)?.outcome, 'ROLLED_BACK');

  const insertHarness = createHarness();
  insertHarness.safety.result = {
    operation: 'INSERT',
    target: { schema: 'public', table: 'orders' },
    normalizedSql: 'INSERT INTO public.orders(id) VALUES (8)',
  };
  const inserted = await prepareAndExecute(insertHarness);
  await insertHarness.manager.rollback(inserted.transactionId);
  assert.equal(insertHarness.activity.auditEvents[0]?.operation, 'INSERT');
  assert.equal(insertHarness.activity.attempts[0]?.operation, 'INSERT');
});

test('22: Safety BLOCKED mutation is audited without any PostgreSQL request', async () => {
  const harness = createHarness();
  harness.safety.error = new MutationSafetyError({
    operation: 'UPDATE',
    target: { schema: 'public', table: 'orders' },
    message: 'UPDATE requires a WHERE clause.',
  });

  await assert.rejects(() => harness.manager.prepareMutation('UPDATE public.orders SET status = \'X\''));

  assert.equal(harness.client.requests.length, 0);
  assert.equal(harness.activity.attempts.length, 1);
  assert.equal(harness.activity.attempts[0]?.status, 'BLOCKED');
  assert.equal(harness.activity.attempts[0]?.operation, 'UPDATE');
});

test('pending gate blocks Test Connection and Connect before creating a client', async () => {
  const gate = new PostgresOperationGate();
  gate.reserveForMutation('50bd58f4-1f5c-4760-822a-533013583ada');
  let factoryCalls = 0;
  const manager = new PostgresConnectionManager(
    () => { factoryCalls += 1; return new FakeMutationClient(); },
    { findById: () => undefined },
    fakeCredentials,
    gate,
  );
  const request = temporaryRequest();

  await assert.rejects(() => manager.testConnection(request));
  await assert.rejects(() => manager.connect(request));
  assert.equal(factoryCalls, 0);
});

test('an active SELECT blocks mutation execution and other PostgreSQL interleaving', async () => {
  const harness = createHarness();
  const prepared = await harness.manager.prepareMutation(normalizedUpdate);
  const selectResult = createDeferred<PostgresQueryResult>();
  const selectStarted = createDeferred<void>();
  harness.client.queryImplementation = async (request) => {
    if (typeof request === 'string') return { rows: [] };
    selectStarted.resolve();
    return selectResult.promise;
  };
  const runner: SelectQueryRunner = {
    start: (client, config) => ({
      result: client.query(config),
      requestCancel: () => Promise.reject(new Error('not used')),
    }),
  };
  const selectService = new PostgresQueryExecutionService(
    harness.provider,
    { validateSelect: async () => ({ normalizedSql: 'SELECT 1', executableSql: 'SELECT 1' }) },
    harness.activity,
    harness.gate,
    runner,
  );
  const metadataService = new PostgresMetadataService(harness.provider);

  const execution = selectService.executeSelect('SELECT 1');
  await selectStarted.promise;
  await assert.rejects(() => harness.manager.prepareMutation(normalizedUpdate), MutationTransactionError);
  await assert.rejects(() => harness.manager.executeMutation(prepared.preparationId), MutationTransactionError);
  await assert.rejects(() => metadataService.listSchemas());
  assert.equal(harness.client.requests.includes(normalizedUpdate), false);

  selectResult.resolve({ rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }] });
  await execution;
  assert.equal(harness.gate.hasActiveSelect(), false);
});

test('disconnect during SELECT cancels, rolls back, then closes the permanent client', async () => {
  const harness = await createConnectionManagerHarness();
  const selectResult = createDeferred<PostgresQueryResult>();
  const selectStarted = createDeferred<void>();
  const cancelSent = createDeferred<void>();
  harness.client.queryImplementation = async (request) => {
    if (typeof request === 'string') return { rows: [] };
    selectStarted.resolve();
    return selectResult.promise;
  };
  const runner: SelectQueryRunner = {
    start: (client, config) => ({
      result: client.query(config),
      requestCancel: async () => { cancelSent.resolve(); },
    }),
  };
  const selectService = new PostgresQueryExecutionService(
    harness.connectionManager,
    { validateSelect: async () => ({ normalizedSql: 'SELECT pg_sleep(10)', executableSql: 'SELECT pg_sleep(10)' }) },
    harness.activity,
    harness.gate,
    runner,
  );
  harness.connectionManager.setBeforeDisconnectHandler(async () => {
    await selectService.cancelBeforeDisconnect();
    await harness.manager.rollbackBeforeDisconnect();
  });

  const execution = selectService.executeSelect('SELECT pg_sleep(10)');
  await selectStarted.promise;
  const disconnect = harness.connectionManager.disconnect();
  await cancelSent.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  selectResult.reject(Object.assign(new Error('raw cancel detail'), { code: '57014' }));
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.kind === 'CANCELLED',
  );
  await disconnect;

  assert.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
  assert.equal(harness.connectionManager.getConnectionState().status, 'DISCONNECTED');
  assert.equal(harness.gate.hasActiveSelect(), false);
  assert.equal(harness.activity.attempts.at(-1)?.status, 'CANCELLED');
});

function createHarness() {
  const gate = new PostgresOperationGate();
  const client = new FakeMutationClient();
  const provider = new GateAwareProvider(client, gate);
  const safety = new FakeMutationSafety();
  const activity = new RecordingActivity();
  const timer = new FakeTimer();
  const manager = new MutationTransactionManager(provider, safety, gate, activity, timer);
  return { activity, client, gate, manager, provider, safety, timer };
}

async function prepareAndExecute(harness: { manager: MutationTransactionManager }) {
  const preparation = await harness.manager.prepareMutation(normalizedUpdate);
  return harness.manager.executeMutation(preparation.preparationId);
}

async function createConnectionManagerHarness() {
  const gate = new PostgresOperationGate();
  const client = new FakeMutationClient();
  const connectionManager = new PostgresConnectionManager(
    () => client,
    { findById: () => undefined },
    fakeCredentials,
    gate,
  );
  await connectionManager.connect(temporaryRequest());
  const safety = new FakeMutationSafety();
  const activity = new RecordingActivity();
  const timer = new FakeTimer();
  const manager = new MutationTransactionManager(connectionManager, safety, gate, activity, timer);
  connectionManager.setBeforeDisconnectHandler(() => manager.rollbackBeforeDisconnect());
  return { activity, client, connectionManager, gate, manager, provider: connectionManager, safety, timer };
}

const fakeCredentials: CredentialStorage = {
  isEncryptionAvailable: () => false,
  encrypt: () => Buffer.alloc(0),
  decrypt: () => '',
};

function temporaryRequest(): ConnectionRequest {
  return {
    source: 'temporary',
    connection: {
      name: 'SUPRA TEST',
      host: 'test-db',
      port: 5432,
      database: 'supra_test',
      username: 'support_user',
      environment: 'TEST',
    },
    temporaryPassword: 'test-only-password',
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}
