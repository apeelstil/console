"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const postgresQueryExecutionService_1 = require("../electron/postgres/postgresQueryExecutionService");
const sqlSafetyService_1 = require("../electron/postgres/sqlSafetyService");
const safeQuery = {
    normalizedSql: 'SELECT id FROM orders',
    executableSql: 'SELECT * FROM (SELECT id FROM orders) AS "__supra_query_result" LIMIT 1001;',
};
class FakeSafetyValidator {
    calls = 0;
    async validateSelect(_sql) {
        void _sql;
        this.calls += 1;
        return safeQuery;
    }
}
class FakeExecutionClient {
    requests = [];
    queryImplementation = async (request) => typeof request === 'string' ? { rows: [] } : selectResult([[1]]);
    async connect() { }
    async query(request) {
        this.requests.push(request);
        return this.queryImplementation(request);
    }
    async end() { }
    on(_event, _listener) {
        void _event;
        void _listener;
        return this;
    }
}
class FakeActiveClientProvider {
    client;
    connected = true;
    constructor(client) {
        this.client = client;
    }
    getConnectionState() {
        return {
            status: 'CONNECTED',
            connection: {
                profileId: '1d6f30cc-e32a-4a4b-b846-708e65fa85c9',
                name: 'SUPRA TEST',
                host: 'test-db',
                port: 5432,
                database: 'supra_test',
                username: 'support_user',
                environment: 'TEST',
            },
        };
    }
    async withActiveClient(operation) {
        if (!this.connected)
            throw new Error('not connected');
        return operation(this.client);
    }
}
class FakeActivityRecorder {
    attempts = [];
    warnings = [];
    async recordAttempt(attempt) {
        this.attempts.push(attempt);
        return { warnings: this.warnings };
    }
}
(0, node_test_1.default)('12: execution uses BEGIN READ ONLY, local timeout, SELECT, and ROLLBACK in order', async () => {
    const { activity, client, service } = createHarness();
    const result = await service.executeSelect('SELECT id FROM orders');
    strict_1.default.equal(client.requests[0], 'BEGIN READ ONLY;');
    strict_1.default.equal(client.requests[1], "SET LOCAL statement_timeout = '15000ms';");
    strict_1.default.deepEqual(client.requests[2], { text: safeQuery.executableSql, rowMode: 'array' });
    strict_1.default.equal(client.requests[3], 'ROLLBACK;');
    strict_1.default.equal(result.returnedRows, 1);
    strict_1.default.equal(activity.attempts[0]?.status, 'SUCCESS');
    strict_1.default.equal(activity.attempts[0]?.connection?.database, 'supra_test');
});
(0, node_test_1.default)('13: a SELECT error still executes ROLLBACK', async () => {
    const { activity, client, service } = createHarness();
    client.queryImplementation = async (request) => {
        if (typeof request !== 'string')
            throw Object.assign(new Error('raw internal failure'), { code: 'XX000' });
        return { rows: [] };
    };
    await strict_1.default.rejects(() => service.executeSelect('SELECT broken FROM orders'), postgresQueryExecutionService_1.QueryExecutionError);
    strict_1.default.deepEqual(client.requests, [
        'BEGIN READ ONLY;',
        "SET LOCAL statement_timeout = '15000ms';",
        { text: safeQuery.executableSql, rowMode: 'array' },
        'ROLLBACK;',
    ]);
    strict_1.default.equal(activity.attempts[0]?.status, 'ERROR');
});
(0, node_test_1.default)('14: statement timeout is converted to a safe error and rolled back', async () => {
    const { activity, client, service } = createHarness();
    client.queryImplementation = async (request) => {
        if (typeof request !== 'string') {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        }
        return { rows: [] };
    };
    await strict_1.default.rejects(() => service.executeSelect('SELECT pg_sleep(30)'), (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.kind === 'TIMEOUT'
        && error.details.sqlState === '57014'
        && !error.details.message.includes('pg_sleep'));
    strict_1.default.equal(client.requests.at(-1), 'ROLLBACK;');
    strict_1.default.equal(activity.attempts[0]?.status, 'TIMEOUT');
    strict_1.default.equal(activity.attempts[0]?.errorCode, '57014');
});
(0, node_test_1.default)('Safety BLOCKED is recorded without opening a PostgreSQL transaction', async () => {
    const client = new FakeExecutionClient();
    const provider = new FakeActiveClientProvider(client);
    const activity = new FakeActivityRecorder();
    const blockingSafety = {
        validateSelect: async () => {
            throw new sqlSafetyService_1.SqlSafetyError({ kind: 'NOT_ALLOWED', message: 'Only SELECT is allowed.' });
        },
    };
    const service = new postgresQueryExecutionService_1.PostgresQueryExecutionService(provider, blockingSafety, activity);
    await strict_1.default.rejects(() => service.executeSelect('DELETE FROM orders'), (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError && error.details.kind === 'NOT_ALLOWED');
    strict_1.default.equal(client.requests.length, 0);
    strict_1.default.equal(activity.attempts.length, 1);
    strict_1.default.equal(activity.attempts[0]?.status, 'BLOCKED');
    strict_1.default.equal(activity.attempts[0]?.sqlText, 'DELETE FROM orders');
});
(0, node_test_1.default)('an audit storage warning never converts a successful SELECT into a failure', async () => {
    const { activity, service } = createHarness();
    activity.warnings = ['Audit log could not be written.'];
    const result = await service.executeSelect('SELECT id FROM orders');
    strict_1.default.equal(result.returnedRows, 1);
    strict_1.default.deepEqual(result.storageWarnings, ['Audit log could not be written.']);
});
(0, node_test_1.default)('15: only 1000 rows are returned and the 1001st marks the result truncated', async () => {
    const { client, service } = createHarness();
    const rows = Array.from({ length: 1_001 }, (_value, index) => [index + 1]);
    client.queryImplementation = async (request) => (typeof request === 'string' ? { rows: [] } : selectResult(rows));
    const result = await service.executeSelect('SELECT id FROM orders');
    strict_1.default.equal(asConfig(client.requests[2]).text.includes('LIMIT 1001'), true);
    strict_1.default.equal(result.returnedRows, 1_000);
    strict_1.default.equal(result.rows.length, 1_000);
    strict_1.default.equal(result.truncated, true);
    strict_1.default.deepEqual(result.rows.at(-1), [1_000]);
});
(0, node_test_1.default)('16: a query error does not destroy a live active connection', async () => {
    const { client, provider, service } = createHarness();
    let selectCalls = 0;
    client.queryImplementation = async (request) => {
        if (typeof request === 'string')
            return { rows: [] };
        selectCalls += 1;
        if (selectCalls === 1)
            throw Object.assign(new Error('relation permission changed'), { code: '42501' });
        return selectResult([[7]]);
    };
    await strict_1.default.rejects(() => service.executeSelect('SELECT id FROM orders'), postgresQueryExecutionService_1.QueryExecutionError);
    strict_1.default.equal(provider.connected, true);
    const secondResult = await service.executeSelect('SELECT id FROM orders');
    strict_1.default.deepEqual(secondResult.rows, [[7]]);
    strict_1.default.equal(provider.connected, true);
});
(0, node_test_1.default)('17: a concurrent double Execute is blocked before a second transaction starts', async () => {
    const { client, safety, service } = createHarness();
    const selectReached = createDeferred();
    const selectResultDeferred = createDeferred();
    client.queryImplementation = async (request) => {
        if (typeof request === 'string')
            return { rows: [] };
        selectReached.resolve();
        return selectResultDeferred.promise;
    };
    const firstExecution = service.executeSelect('SELECT id FROM orders');
    await selectReached.promise;
    await strict_1.default.rejects(() => service.executeSelect('SELECT id FROM orders'), (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.message === 'A query is already executing.');
    strict_1.default.equal(safety.calls, 1);
    strict_1.default.equal(client.requests.filter((request) => request === 'BEGIN READ ONLY;').length, 1);
    selectResultDeferred.resolve(selectResult([[1]]));
    await firstExecution;
});
(0, node_test_1.default)('18: Result DTO normalizes dates, JSON, bigint, binary, and excludes sensitive objects', async () => {
    const { client, service } = createHarness();
    const jsonValue = { status: 'NEW', nested: { count: 2 } };
    const binary = Buffer.from([0xde, 0xad]);
    client.queryImplementation = async (request) => typeof request === 'string'
        ? { rows: [] }
        : {
            rows: [[
                    'text', 42, true, null, new Date('2026-08-24T10:00:00.000Z'),
                    jsonValue, 9007199254740993n, binary,
                ]],
            fields: [
                field('text_value', 25), field('number_value', 23), field('bool_value', 16),
                field('null_value', 25), field('date_value', 1184), field('json_value', 3802),
                field('bigint_value', 20), field('binary_value', 17),
            ],
        };
    const result = await service.executeSelect('SELECT values');
    const serialized = JSON.stringify(result);
    strict_1.default.deepEqual(result.rows[0], [
        'text', 42, true, null, '2026-08-24T10:00:00.000Z',
        JSON.stringify(jsonValue), '9007199254740993', '\\xdead',
    ]);
    strict_1.default.deepEqual(result.columns[5], { name: 'json_value', dataTypeId: 3802 });
    strict_1.default.equal(result.rows[0]?.[5], '{"status":"NEW","nested":{"count":2}}');
    strict_1.default.equal(serialized.includes('[object Object]'), false);
    strict_1.default.equal(serialized.includes('password'), false);
    strict_1.default.equal(serialized.includes('client'), false);
    strict_1.default.equal(serialized.includes('socket'), false);
    strict_1.default.equal('queryImplementation' in result, false);
});
(0, node_test_1.default)('19: successful cancellation sends one request, rolls back, and records CANCELLED', async () => {
    const harness = createCancellationHarness();
    const execution = harness.service.executeSelect('SELECT pg_sleep(10)');
    await harness.runner.started.promise;
    const operation = harness.service.getState();
    strict_1.default.equal(operation.status, 'EXECUTING');
    if (operation.status !== 'EXECUTING')
        return;
    const cancellationState = await harness.service.cancelSelect(operation.operationId);
    strict_1.default.equal(cancellationState.status, 'CANCELLING');
    harness.selectResult.reject(cancelledQueryError());
    await strict_1.default.rejects(execution, (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.kind === 'CANCELLED'
        && error.details.sqlState === '57014');
    strict_1.default.equal(harness.runner.cancelCalls, 1);
    strict_1.default.equal(harness.client.requests.at(-1), 'ROLLBACK;');
    strict_1.default.equal(harness.activity.attempts.at(-1)?.status, 'CANCELLED');
    strict_1.default.equal(harness.activity.attempts.at(-1)?.errorMessage, 'Query cancelled');
    strict_1.default.deepEqual(harness.service.getState(), { status: 'IDLE', message: 'Query cancelled' });
});
(0, node_test_1.default)('20: the permanent connection remains usable after cancellation', async () => {
    const harness = createCancellationHarness();
    let selectCall = 0;
    harness.client.queryImplementation = async (request) => {
        if (typeof request === 'string')
            return { rows: [] };
        selectCall += 1;
        return selectCall === 1 ? harness.selectResult.promise : selectResult([[9]]);
    };
    const firstExecution = harness.service.executeSelect('SELECT pg_sleep(10)');
    await harness.runner.started.promise;
    const operation = harness.service.getState();
    strict_1.default.equal(operation.status, 'EXECUTING');
    if (operation.status !== 'EXECUTING')
        return;
    await harness.service.cancelSelect(operation.operationId);
    harness.selectResult.reject(cancelledQueryError());
    await strict_1.default.rejects(firstExecution, postgresQueryExecutionService_1.QueryExecutionError);
    const secondResult = await harness.service.executeSelect('SELECT 9');
    strict_1.default.deepEqual(secondResult.rows, [[9]]);
    strict_1.default.equal(harness.provider.connected, true);
});
(0, node_test_1.default)('21: a double Cancel sends only one PostgreSQL cancellation request', async () => {
    const cancelRequest = createDeferred();
    const harness = createCancellationHarness(() => cancelRequest.promise);
    const execution = harness.service.executeSelect('SELECT pg_sleep(10)');
    await harness.runner.started.promise;
    const operation = harness.service.getState();
    strict_1.default.equal(operation.status, 'EXECUTING');
    if (operation.status !== 'EXECUTING')
        return;
    const firstCancel = harness.service.cancelSelect(operation.operationId);
    await strict_1.default.rejects(() => harness.service.cancelSelect(operation.operationId), (error) => error instanceof postgresQueryExecutionService_1.QueryOperationError
        && error.safeMessage === 'Query cancellation is already in progress.');
    strict_1.default.equal(harness.runner.cancelCalls, 1);
    cancelRequest.resolve();
    await firstCancel;
    harness.selectResult.reject(cancelledQueryError());
    await strict_1.default.rejects(execution, postgresQueryExecutionService_1.QueryExecutionError);
});
(0, node_test_1.default)('22: Cancel after SELECT completion is safely rejected', async () => {
    const { service } = createHarness();
    await service.executeSelect('SELECT id FROM orders');
    await strict_1.default.rejects(() => service.cancelSelect('00000000-0000-4000-8000-000000000000'), (error) => error instanceof postgresQueryExecutionService_1.QueryOperationError
        && error.safeMessage === 'No matching SELECT query is executing.');
});
(0, node_test_1.default)('23: timeout and manual cancellation remain distinct outcomes', async () => {
    const timeoutHarness = createHarness();
    timeoutHarness.client.queryImplementation = async (request) => {
        if (typeof request !== 'string')
            throw cancelledQueryError();
        return { rows: [] };
    };
    await strict_1.default.rejects(() => timeoutHarness.service.executeSelect('SELECT pg_sleep(30)'), (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.kind === 'TIMEOUT');
    const cancelledHarness = createCancellationHarness();
    const execution = cancelledHarness.service.executeSelect('SELECT pg_sleep(10)');
    await cancelledHarness.runner.started.promise;
    const operation = cancelledHarness.service.getState();
    strict_1.default.equal(operation.status, 'EXECUTING');
    if (operation.status !== 'EXECUTING')
        return;
    await cancelledHarness.service.cancelSelect(operation.operationId);
    cancelledHarness.selectResult.reject(cancelledQueryError());
    await strict_1.default.rejects(execution, (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.kind === 'CANCELLED');
    strict_1.default.equal(timeoutHarness.activity.attempts.at(-1)?.status, 'TIMEOUT');
    strict_1.default.equal(cancelledHarness.activity.attempts.at(-1)?.status, 'CANCELLED');
});
function createHarness() {
    const client = new FakeExecutionClient();
    const provider = new FakeActiveClientProvider(client);
    const safety = new FakeSafetyValidator();
    const activity = new FakeActivityRecorder();
    const service = new postgresQueryExecutionService_1.PostgresQueryExecutionService(provider, safety, activity);
    return { activity, client, provider, safety, service };
}
class FakeCancelableRunner {
    cancelImplementation;
    started = createDeferred();
    cancelCalls = 0;
    constructor(cancelImplementation) {
        this.cancelImplementation = cancelImplementation;
    }
    start(client, config) {
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
function createCancellationHarness(cancelImplementation = async () => undefined) {
    const client = new FakeExecutionClient();
    const provider = new FakeActiveClientProvider(client);
    const safety = new FakeSafetyValidator();
    const activity = new FakeActivityRecorder();
    const selectResultDeferred = createDeferred();
    client.queryImplementation = async (request) => (typeof request === 'string' ? { rows: [] } : selectResultDeferred.promise);
    const runner = new FakeCancelableRunner(cancelImplementation);
    const service = new postgresQueryExecutionService_1.PostgresQueryExecutionService(provider, safety, activity, undefined, runner);
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
function selectResult(rows) {
    return { rows, fields: [field('id', 23)] };
}
function field(name, dataTypeID) {
    return { name, dataTypeID };
}
function asConfig(request) {
    strict_1.default.equal(typeof request, 'object');
    return request;
}
function createDeferred() {
    let resolvePromise = () => undefined;
    let rejectPromise = () => undefined;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}
function cancelledQueryError() {
    return Object.assign(new Error('raw PostgreSQL cancellation detail'), { code: '57014' });
}
