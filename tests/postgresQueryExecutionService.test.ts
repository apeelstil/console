import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PostgresClient,
  PostgresQueryConfig,
  PostgresQueryResult,
} from '../electron/postgres/postgresConnectionManager';
import {
  PostgresQueryExecutionService,
  QueryExecutionError,
  QueryOperationError,
  type ExclusiveActiveClientProvider,
  type SelectQueryRunner,
  type SelectSafetyValidator,
} from '../electron/postgres/postgresQueryExecutionService';
import type {
  QueryActivityAttempt,
  QueryActivityRecorder,
  QueryActivityRecordResult,
} from '../electron/storage/queryActivityService';
import { SqlSafetyError } from '../electron/postgres/sqlSafetyService';

const safeQuery = {
  normalizedSql: 'SELECT id FROM orders',
  executableSql: 'SELECT * FROM (SELECT id FROM orders) AS "__supra_query_result" LIMIT 1001;',
};

class FakeSafetyValidator implements SelectSafetyValidator {
  calls = 0;

  async validateSelect(_sql: string) {
    void _sql;
    this.calls += 1;
    return safeQuery;
  }
}

class FakeExecutionClient implements PostgresClient {
  readonly requests: Array<string | PostgresQueryConfig> = [];
  queryImplementation: (request: string | PostgresQueryConfig) => Promise<PostgresQueryResult> =
    async (request) => typeof request === 'string' ? { rows: [] } : selectResult([[1]]);

  async connect(): Promise<void> {}

  async query(request: string | PostgresQueryConfig): Promise<PostgresQueryResult> {
    this.requests.push(request);
    return this.queryImplementation(request);
  }

  async end(): Promise<void> {}

  on(_event: 'error' | 'end', _listener: ((error: Error) => void) | (() => void)): this {
    void _event;
    void _listener;
    return this;
  }
}

class FakeActiveClientProvider implements ExclusiveActiveClientProvider {
  connected = true;

  constructor(readonly client: FakeExecutionClient) {}

  getConnectionState() {
    return {
      status: 'CONNECTED' as const,
      connection: {
        profileId: '1d6f30cc-e32a-4a4b-b846-708e65fa85c9',
        name: 'SUPRA TEST',
        host: 'test-db',
        port: 5432,
        database: 'supra_test',
        username: 'support_user',
        environment: 'TEST' as const,
      },
    };
  }

  async withActiveClient<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.connected) throw new Error('not connected');
    return operation(this.client);
  }
}

class FakeActivityRecorder implements QueryActivityRecorder {
  readonly attempts: QueryActivityAttempt[] = [];
  warnings: string[] = [];

  async recordAttempt(attempt: QueryActivityAttempt): Promise<QueryActivityRecordResult> {
    this.attempts.push(attempt);
    return { warnings: this.warnings };
  }
}

test('12: execution uses BEGIN READ ONLY, local timeout, SELECT, and ROLLBACK in order', async () => {
  const { activity, client, service } = createHarness();

  const result = await service.executeSelect('SELECT id FROM orders');

  assert.equal(client.requests[0], 'BEGIN READ ONLY;');
  assert.equal(client.requests[1], "SET LOCAL statement_timeout = '15000ms';");
  assert.deepEqual(client.requests[2], { text: safeQuery.executableSql, rowMode: 'array' });
  assert.equal(client.requests[3], 'ROLLBACK;');
  assert.equal(result.returnedRows, 1);
  assert.equal(activity.attempts[0]?.status, 'SUCCESS');
  assert.equal(activity.attempts[0]?.connection?.database, 'supra_test');
});

test('13: a SELECT error still executes ROLLBACK', async () => {
  const { activity, client, service } = createHarness();
  client.queryImplementation = async (request) => {
    if (typeof request !== 'string') throw Object.assign(new Error('raw internal failure'), { code: 'XX000' });
    return { rows: [] };
  };

  await assert.rejects(() => service.executeSelect('SELECT broken FROM orders'), QueryExecutionError);

  assert.deepEqual(client.requests, [
    'BEGIN READ ONLY;',
    "SET LOCAL statement_timeout = '15000ms';",
    { text: safeQuery.executableSql, rowMode: 'array' },
    'ROLLBACK;',
  ]);
  assert.equal(activity.attempts[0]?.status, 'ERROR');
});

test('14: statement timeout is converted to a safe error and rolled back', async () => {
  const { activity, client, service } = createHarness();
  client.queryImplementation = async (request) => {
    if (typeof request !== 'string') {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    return { rows: [] };
  };

  await assert.rejects(
    () => service.executeSelect('SELECT pg_sleep(30)'),
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.kind === 'TIMEOUT'
      && error.details.sqlState === '57014'
      && !error.details.message.includes('pg_sleep'),
  );
  assert.equal(client.requests.at(-1), 'ROLLBACK;');
  assert.equal(activity.attempts[0]?.status, 'TIMEOUT');
  assert.equal(activity.attempts[0]?.errorCode, '57014');
});

test('Safety BLOCKED is recorded without opening a PostgreSQL transaction', async () => {
  const client = new FakeExecutionClient();
  const provider = new FakeActiveClientProvider(client);
  const activity = new FakeActivityRecorder();
  const blockingSafety: SelectSafetyValidator = {
    validateSelect: async () => {
      throw new SqlSafetyError({ kind: 'NOT_ALLOWED', message: 'Only SELECT is allowed.' });
    },
  };
  const service = new PostgresQueryExecutionService(provider, blockingSafety, activity);

  await assert.rejects(
    () => service.executeSelect('DELETE FROM orders'),
    (error: unknown) => error instanceof QueryExecutionError && error.details.kind === 'NOT_ALLOWED',
  );

  assert.equal(client.requests.length, 0);
  assert.equal(activity.attempts.length, 1);
  assert.equal(activity.attempts[0]?.status, 'BLOCKED');
  assert.equal(activity.attempts[0]?.sqlText, 'DELETE FROM orders');
});

test('an audit storage warning never converts a successful SELECT into a failure', async () => {
  const { activity, service } = createHarness();
  activity.warnings = ['Audit log could not be written.'];

  const result = await service.executeSelect('SELECT id FROM orders');

  assert.equal(result.returnedRows, 1);
  assert.deepEqual(result.storageWarnings, ['Audit log could not be written.']);
});

test('15: only 1000 rows are returned and the 1001st marks the result truncated', async () => {
  const { client, service } = createHarness();
  const rows = Array.from({ length: 1_001 }, (_value, index) => [index + 1]);
  client.queryImplementation = async (request) => (
    typeof request === 'string' ? { rows: [] } : selectResult(rows)
  );

  const result = await service.executeSelect('SELECT id FROM orders');

  assert.equal(asConfig(client.requests[2]).text.includes('LIMIT 1001'), true);
  assert.equal(result.returnedRows, 1_000);
  assert.equal(result.rows.length, 1_000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.at(-1), [1_000]);
});

test('16: a query error does not destroy a live active connection', async () => {
  const { client, provider, service } = createHarness();
  let selectCalls = 0;
  client.queryImplementation = async (request) => {
    if (typeof request === 'string') return { rows: [] };
    selectCalls += 1;
    if (selectCalls === 1) throw Object.assign(new Error('relation permission changed'), { code: '42501' });
    return selectResult([[7]]);
  };

  await assert.rejects(() => service.executeSelect('SELECT id FROM orders'), QueryExecutionError);
  assert.equal(provider.connected, true);
  const secondResult = await service.executeSelect('SELECT id FROM orders');
  assert.deepEqual(secondResult.rows, [[7]]);
  assert.equal(provider.connected, true);
});

test('17: a concurrent double Execute is blocked before a second transaction starts', async () => {
  const { client, safety, service } = createHarness();
  const selectReached = createDeferred<void>();
  const selectResultDeferred = createDeferred<PostgresQueryResult>();
  client.queryImplementation = async (request) => {
    if (typeof request === 'string') return { rows: [] };
    selectReached.resolve();
    return selectResultDeferred.promise;
  };

  const firstExecution = service.executeSelect('SELECT id FROM orders');
  await selectReached.promise;
  await assert.rejects(
    () => service.executeSelect('SELECT id FROM orders'),
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.message === 'Запрос уже выполняется.',
  );
  assert.equal(safety.calls, 1);
  assert.equal(client.requests.filter((request) => request === 'BEGIN READ ONLY;').length, 1);

  selectResultDeferred.resolve(selectResult([[1]]));
  await firstExecution;
});

test('18: Result DTO normalizes dates, JSON, bigint, binary, and excludes sensitive objects', async () => {
  const { client, service } = createHarness();
  const jsonValue = { status: 'NEW', nested: { count: 2 } };
  const binary = Buffer.from([0xde, 0xad]);
  client.queryImplementation = async (request) => typeof request === 'string'
    ? { rows: [] }
    : {
        rows: [[
          'text', 42, true, null, new Date('2026-08-24T10:00:00.000Z'),
          jsonValue, 9_007_199_254_740_993n, binary,
        ]],
        fields: [
          field('text_value', 25), field('number_value', 23), field('bool_value', 16),
          field('null_value', 25), field('date_value', 1184), field('json_value', 3802),
          field('bigint_value', 20), field('binary_value', 17),
        ],
      };

  const result = await service.executeSelect('SELECT values');
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.rows[0], [
    'text', 42, true, null, '2026-08-24T10:00:00.000Z',
    JSON.stringify(jsonValue), '9007199254740993', '\\xdead',
  ]);
  assert.deepEqual(result.columns[5], { name: 'json_value', dataTypeId: 3802 });
  assert.equal(result.rows[0]?.[5], '{"status":"NEW","nested":{"count":2}}');
  assert.equal(serialized.includes('[object Object]'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('client'), false);
  assert.equal(serialized.includes('socket'), false);
  assert.equal('queryImplementation' in result, false);
});

test('19: successful cancellation sends one request, rolls back, and records CANCELLED', async () => {
  const harness = createCancellationHarness();
  const execution = harness.service.executeSelect('SELECT pg_sleep(10)');
  await harness.runner.started.promise;
  const operation = harness.service.getState();
  assert.equal(operation.status, 'EXECUTING');
  if (operation.status !== 'EXECUTING') return;

  const cancellationState = await harness.service.cancelSelect(operation.operationId);
  assert.equal(cancellationState.status, 'CANCELLING');
  harness.selectResult.reject(cancelledQueryError());

  await assert.rejects(
    execution,
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.kind === 'CANCELLED'
      && error.details.sqlState === '57014',
  );
  assert.equal(harness.runner.cancelCalls, 1);
  assert.equal(harness.client.requests.at(-1), 'ROLLBACK;');
  assert.equal(harness.activity.attempts.at(-1)?.status, 'CANCELLED');
  assert.equal(harness.activity.attempts.at(-1)?.errorMessage, 'Запрос отменён');
  assert.deepEqual(harness.service.getState(), { status: 'IDLE', message: 'Запрос отменён' });
});

test('20: the permanent connection remains usable after cancellation', async () => {
  const harness = createCancellationHarness();
  let selectCall = 0;
  harness.client.queryImplementation = async (request) => {
    if (typeof request === 'string') return { rows: [] };
    selectCall += 1;
    return selectCall === 1 ? harness.selectResult.promise : selectResult([[9]]);
  };

  const firstExecution = harness.service.executeSelect('SELECT pg_sleep(10)');
  await harness.runner.started.promise;
  const operation = harness.service.getState();
  assert.equal(operation.status, 'EXECUTING');
  if (operation.status !== 'EXECUTING') return;
  await harness.service.cancelSelect(operation.operationId);
  harness.selectResult.reject(cancelledQueryError());
  await assert.rejects(firstExecution, QueryExecutionError);

  const secondResult = await harness.service.executeSelect('SELECT 9');
  assert.deepEqual(secondResult.rows, [[9]]);
  assert.equal(harness.provider.connected, true);
});

test('21: a double Cancel sends only one PostgreSQL cancellation request', async () => {
  const cancelRequest = createDeferred<void>();
  const harness = createCancellationHarness(() => cancelRequest.promise);
  const execution = harness.service.executeSelect('SELECT pg_sleep(10)');
  await harness.runner.started.promise;
  const operation = harness.service.getState();
  assert.equal(operation.status, 'EXECUTING');
  if (operation.status !== 'EXECUTING') return;

  const firstCancel = harness.service.cancelSelect(operation.operationId);
  await assert.rejects(
    () => harness.service.cancelSelect(operation.operationId),
    (error: unknown) => error instanceof QueryOperationError
      && error.safeMessage === 'Отмена запроса уже выполняется.',
  );
  assert.equal(harness.runner.cancelCalls, 1);
  cancelRequest.resolve();
  await firstCancel;
  harness.selectResult.reject(cancelledQueryError());
  await assert.rejects(execution, QueryExecutionError);
});

test('22: Cancel after SELECT completion is safely rejected', async () => {
  const { service } = createHarness();
  await service.executeSelect('SELECT id FROM orders');

  await assert.rejects(
    () => service.cancelSelect('00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof QueryOperationError
      && error.safeMessage === 'Соответствующий запрос SELECT не выполняется.',
  );
});

test('23: timeout and manual cancellation remain distinct outcomes', async () => {
  const timeoutHarness = createHarness();
  timeoutHarness.client.queryImplementation = async (request) => {
    if (typeof request !== 'string') throw cancelledQueryError();
    return { rows: [] };
  };
  await assert.rejects(
    () => timeoutHarness.service.executeSelect('SELECT pg_sleep(30)'),
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.kind === 'TIMEOUT',
  );

  const cancelledHarness = createCancellationHarness();
  const execution = cancelledHarness.service.executeSelect('SELECT pg_sleep(10)');
  await cancelledHarness.runner.started.promise;
  const operation = cancelledHarness.service.getState();
  assert.equal(operation.status, 'EXECUTING');
  if (operation.status !== 'EXECUTING') return;
  await cancelledHarness.service.cancelSelect(operation.operationId);
  cancelledHarness.selectResult.reject(cancelledQueryError());
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof QueryExecutionError
      && error.details.kind === 'CANCELLED',
  );

  assert.equal(timeoutHarness.activity.attempts.at(-1)?.status, 'TIMEOUT');
  assert.equal(cancelledHarness.activity.attempts.at(-1)?.status, 'CANCELLED');
});

function createHarness() {
  const client = new FakeExecutionClient();
  const provider = new FakeActiveClientProvider(client);
  const safety = new FakeSafetyValidator();
  const activity = new FakeActivityRecorder();
  const service = new PostgresQueryExecutionService(provider, safety, activity);
  return { activity, client, provider, safety, service };
}

class FakeCancelableRunner implements SelectQueryRunner {
  readonly started = createDeferred<void>();
  cancelCalls = 0;

  constructor(private readonly cancelImplementation: () => Promise<void>) {}

  start(client: PostgresClient, config: PostgresQueryConfig) {
    const result = client.query(config);
    this.started.resolve();
    return {
      result,
      requestCancel: async () => {
        this.cancelCalls += 1;
        await this.cancelImplementation();
      },
    };
  }
}

function createCancellationHarness(cancelImplementation: () => Promise<void> = async () => undefined) {
  const client = new FakeExecutionClient();
  const provider = new FakeActiveClientProvider(client);
  const safety = new FakeSafetyValidator();
  const activity = new FakeActivityRecorder();
  const selectResultDeferred = createDeferred<PostgresQueryResult>();
  client.queryImplementation = async (request) => (
    typeof request === 'string' ? { rows: [] } : selectResultDeferred.promise
  );
  const runner = new FakeCancelableRunner(cancelImplementation);
  const service = new PostgresQueryExecutionService(
    provider,
    safety,
    activity,
    undefined,
    runner,
  );
  return {
    activity,
    client,
    provider,
    runner,
    safety,
    selectResult: selectResultDeferred,
    service,
  };
}

function selectResult(rows: unknown[][]): PostgresQueryResult {
  return { rows, fields: [field('id', 23)] };
}

function field(name: string, dataTypeID: number) {
  return { name, dataTypeID };
}

function asConfig(request: string | PostgresQueryConfig | undefined): PostgresQueryConfig {
  assert.equal(typeof request, 'object');
  return request as PostgresQueryConfig;
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

function cancelledQueryError(): Error & { code: string } {
  return Object.assign(new Error('raw PostgreSQL cancellation detail'), { code: '57014' });
}
