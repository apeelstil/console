"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const mutationTransactionManager_1 = require("../electron/postgres/mutationTransactionManager");
const postgresConnectionManager_1 = require("../electron/postgres/postgresConnectionManager");
const postgresOperationGate_1 = require("../electron/postgres/postgresOperationGate");
const postgresQueryExecutionService_1 = require("../electron/postgres/postgresQueryExecutionService");
const postgresMetadataService_1 = require("../electron/postgres/postgresMetadataService");
const mutationSafetyService_1 = require("../electron/postgres/mutationSafetyService");
const normalizedUpdate = "UPDATE public.orders SET status = 'DONE' WHERE id = 7";
const safeUpdate = {
    operation: 'UPDATE',
    target: { schema: 'public', table: 'orders' },
    normalizedSql: normalizedUpdate,
};
const connectedState = {
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
class FakeMutationClient {
    requests = [];
    lifecycle = [];
    affectedRows = 3;
    failMutation;
    failCommit;
    failRollback;
    queryImplementation;
    async connect() { this.lifecycle.push('CONNECT'); }
    async query(request) {
        this.requests.push(request);
        const text = typeof request === 'string' ? request : request.text;
        this.lifecycle.push(text);
        if (text === normalizedUpdate && this.failMutation)
            throw this.failMutation;
        if (text === 'COMMIT;' && this.failCommit)
            throw this.failCommit;
        if (text === 'ROLLBACK;' && this.failRollback)
            throw this.failRollback;
        if (this.queryImplementation)
            return this.queryImplementation(request);
        return { rows: [], rowCount: text === normalizedUpdate ? this.affectedRows : null };
    }
    async end() { this.lifecycle.push('END'); }
    on() {
        return this;
    }
}
class GateAwareProvider {
    client;
    gate;
    state = connectedState;
    constructor(client, gate) {
        this.client = client;
        this.gate = gate;
    }
    getConnectionState() { return structuredClone(this.state); }
    async withActiveClient(operation, access = {}) {
        if (access.mutationTransactionId)
            this.gate.assertMutationOwner(access.mutationTransactionId);
        else if (access.selectOperationId)
            this.gate.assertSelectOwner(access.selectOperationId);
        else
            this.gate.assertStandardOperationAllowed();
        return operation(this.client);
    }
}
class FakeMutationSafety {
    calls = 0;
    error;
    result = safeUpdate;
    async validateMutation() {
        this.calls += 1;
        if (this.error)
            throw this.error;
        return this.result;
    }
}
class RecordingActivity {
    attempts = [];
    auditEvents = [];
    async recordAttempt(attempt) {
        this.attempts.push(attempt);
        return { warnings: [] };
    }
    async recordAuditEvent(event) {
        this.auditEvents.push(event);
        return { warnings: [] };
    }
}
class FakeTimer {
    callback;
    delayMs;
    cleared = false;
    set(callback, delayMs) {
        this.callback = callback;
        this.delayMs = delayMs;
        this.cleared = false;
        return 1;
    }
    clear() { this.cleared = true; this.callback = undefined; }
    async fire() {
        const callback = this.callback;
        this.callback = undefined;
        if (callback)
            await callback();
    }
}
(0, node_test_1.default)('10/11: successful mutation becomes PENDING without COMMIT and returns affectedRows', async () => {
    const harness = createHarness();
    const pending = await prepareAndExecute(harness);
    strict_1.default.equal(pending.status, 'PENDING_CONFIRMATION');
    strict_1.default.equal(pending.affectedRows, 3);
    strict_1.default.deepEqual(harness.client.requests, [
        'BEGIN;',
        "SET LOCAL statement_timeout = '15000ms';",
        "SET LOCAL lock_timeout = '5000ms';",
        normalizedUpdate,
    ]);
    strict_1.default.equal(harness.client.requests.includes('COMMIT;'), false);
    strict_1.default.equal(harness.manager.getState().status, 'PENDING_CONFIRMATION');
    strict_1.default.equal(harness.timer.delayMs, mutationTransactionManager_1.MUTATION_CONFIRMATION_TIMEOUT_MS);
});
(0, node_test_1.default)('12: COMMIT completes only the matching pending transaction and cannot be repeated', async () => {
    const harness = createHarness();
    const pending = await prepareAndExecute(harness);
    await strict_1.default.rejects(() => harness.manager.commit('ebbc44d7-56ab-463b-89a8-d3ed7c8cf5db'), mutationTransactionManager_1.MutationTransactionError);
    strict_1.default.equal(harness.client.requests.includes('COMMIT;'), false);
    const state = await harness.manager.commit(pending.transactionId);
    strict_1.default.deepEqual(state, { status: 'IDLE', message: 'Changes committed' });
    strict_1.default.equal(harness.client.requests.at(-1), 'COMMIT;');
    strict_1.default.equal(harness.timer.cleared, true);
    await strict_1.default.rejects(() => harness.manager.commit(pending.transactionId), mutationTransactionManager_1.MutationTransactionError);
});
(0, node_test_1.default)('13: ROLLBACK cancels the pending transaction and cannot be repeated', async () => {
    const harness = createHarness();
    const pending = await prepareAndExecute(harness);
    const state = await harness.manager.rollback(pending.transactionId);
    strict_1.default.deepEqual(state, { status: 'IDLE', message: 'Changes rolled back' });
    strict_1.default.equal(harness.client.requests.at(-1), 'ROLLBACK;');
    await strict_1.default.rejects(() => harness.manager.rollback(pending.transactionId), mutationTransactionManager_1.MutationTransactionError);
});
(0, node_test_1.default)('an unconfirmed COMMIT and fallback ROLLBACK keep the transaction exclusive', async () => {
    const harness = createHarness();
    const pending = await prepareAndExecute(harness);
    harness.client.failCommit = Object.assign(new Error('raw commit transport failure'), { code: 'ECONNRESET' });
    harness.client.failRollback = Object.assign(new Error('raw rollback transport failure'), { code: 'ECONNRESET' });
    await strict_1.default.rejects(() => harness.manager.commit(pending.transactionId), (error) => error instanceof mutationTransactionManager_1.MutationTransactionError
        && error.safeMessage.includes('transaction remains pending')
        && !error.safeMessage.includes('raw'));
    strict_1.default.equal(harness.manager.getState().status, 'PENDING_CONFIRMATION');
    strict_1.default.equal(harness.gate.hasPendingMutation(), true);
    harness.client.failRollback = undefined;
    await harness.manager.rollback(pending.transactionId);
    strict_1.default.equal(harness.gate.hasPendingMutation(), false);
});
(0, node_test_1.default)('14: statement error immediately ROLLBACKs and creates no pending transaction', async () => {
    const harness = createHarness();
    harness.client.failMutation = Object.assign(new Error('raw duplicate detail'), { code: '23505' });
    const prepared = await harness.manager.prepareMutation(normalizedUpdate);
    await strict_1.default.rejects(() => harness.manager.executeMutation(prepared.preparationId), (error) => error instanceof mutationTransactionManager_1.MutationTransactionError
        && error.safeMessage === 'The mutation violates a unique constraint.'
        && !error.safeMessage.includes('raw duplicate'));
    strict_1.default.equal(harness.client.requests.at(-1), 'ROLLBACK;');
    strict_1.default.equal(harness.manager.getState().status, 'ERROR');
    strict_1.default.equal(harness.gate.hasPendingMutation(), false);
    strict_1.default.equal(harness.activity.attempts.at(-1)?.status, 'ERROR');
});
(0, node_test_1.default)('15: a second mutation is blocked while one transaction is pending', async () => {
    const harness = createHarness();
    await prepareAndExecute(harness);
    const requestCount = harness.client.requests.length;
    await strict_1.default.rejects(() => harness.manager.prepareMutation(normalizedUpdate), mutationTransactionManager_1.MutationTransactionError);
    strict_1.default.equal(harness.client.requests.length, requestCount);
    strict_1.default.equal(harness.safety.calls, 2);
});
(0, node_test_1.default)('16: SELECT and metadata are blocked by the main-process gate while pending', async () => {
    const harness = createHarness();
    await prepareAndExecute(harness);
    const selectService = new postgresQueryExecutionService_1.PostgresQueryExecutionService(harness.provider, { validateSelect: async () => ({ normalizedSql: 'SELECT 1', executableSql: 'SELECT 1' }) }, harness.activity, harness.gate);
    const metadataService = new postgresMetadataService_1.PostgresMetadataService(harness.provider);
    await strict_1.default.rejects(() => selectService.executeSelect('SELECT 1'));
    await strict_1.default.rejects(() => metadataService.listSchemas());
    strict_1.default.equal(harness.client.requests.includes('SELECT 1'), false);
    strict_1.default.equal(harness.activity.attempts.at(-1)?.errorMessage?.includes('COMMIT or ROLLBACK'), true);
});
(0, node_test_1.default)('17: pending transaction automatically rolls back after 120 seconds', async () => {
    const harness = createHarness();
    await prepareAndExecute(harness);
    await harness.timer.fire();
    strict_1.default.equal(harness.client.requests.at(-1), 'ROLLBACK;');
    strict_1.default.deepEqual(harness.manager.getState(), {
        status: 'IDLE',
        message: 'Transaction automatically rolled back due to timeout',
    });
    strict_1.default.equal(harness.activity.auditEvents.at(-1)?.outcome, 'AUTO_ROLLED_BACK');
});
(0, node_test_1.default)('18: disconnect hook rolls back before the PostgreSQL client is closed', async () => {
    const harness = await createConnectionManagerHarness();
    await prepareAndExecute(harness);
    await harness.connectionManager.disconnect();
    strict_1.default.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
    strict_1.default.equal(harness.manager.getState().status, 'IDLE');
});
(0, node_test_1.default)('19: application shutdown uses the same rollback-before-close hook', async () => {
    const harness = await createConnectionManagerHarness();
    await prepareAndExecute(harness);
    await harness.connectionManager.shutdown();
    strict_1.default.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
    strict_1.default.equal(harness.manager.getState().status, 'IDLE');
});
(0, node_test_1.default)('20: connection loss clears local pending state and releases the gate', async () => {
    const harness = createHarness();
    await prepareAndExecute(harness);
    await harness.manager.handleConnectionLoss();
    strict_1.default.equal(harness.manager.getState().status, 'IDLE');
    strict_1.default.equal(harness.gate.hasPendingMutation(), false);
    strict_1.default.equal(harness.activity.auditEvents.at(-1)?.outcome, 'CONNECTION_LOST');
    await harness.provider.withActiveClient(async () => undefined);
});
(0, node_test_1.default)('21: Audit records UPDATE pending plus COMMIT and INSERT/UPDATE plus ROLLBACK operations', async () => {
    const commitHarness = createHarness();
    const committed = await prepareAndExecute(commitHarness);
    await commitHarness.manager.commit(committed.transactionId);
    strict_1.default.deepEqual(commitHarness.activity.auditEvents.map((event) => [event.operation, event.outcome]), [['UPDATE', 'VALIDATED'], ['COMMIT', 'COMMITTED']]);
    strict_1.default.equal(commitHarness.activity.attempts[0]?.operation, 'UPDATE');
    strict_1.default.equal(commitHarness.activity.attempts[0]?.auditOutcome, 'PENDING');
    const rollbackHarness = createHarness();
    const rolledBack = await prepareAndExecute(rollbackHarness);
    await rollbackHarness.manager.rollback(rolledBack.transactionId);
    strict_1.default.equal(rollbackHarness.activity.auditEvents.at(-1)?.operation, 'ROLLBACK');
    strict_1.default.equal(rollbackHarness.activity.auditEvents.at(-1)?.outcome, 'ROLLED_BACK');
    const insertHarness = createHarness();
    insertHarness.safety.result = {
        operation: 'INSERT',
        target: { schema: 'public', table: 'orders' },
        normalizedSql: 'INSERT INTO public.orders(id) VALUES (8)',
    };
    const inserted = await prepareAndExecute(insertHarness);
    await insertHarness.manager.rollback(inserted.transactionId);
    strict_1.default.equal(insertHarness.activity.auditEvents[0]?.operation, 'INSERT');
    strict_1.default.equal(insertHarness.activity.attempts[0]?.operation, 'INSERT');
});
(0, node_test_1.default)('22: Safety BLOCKED mutation is audited without any PostgreSQL request', async () => {
    const harness = createHarness();
    harness.safety.error = new mutationSafetyService_1.MutationSafetyError({
        operation: 'UPDATE',
        target: { schema: 'public', table: 'orders' },
        message: 'UPDATE requires a WHERE clause.',
    });
    await strict_1.default.rejects(() => harness.manager.prepareMutation('UPDATE public.orders SET status = \'X\''));
    strict_1.default.equal(harness.client.requests.length, 0);
    strict_1.default.equal(harness.activity.attempts.length, 1);
    strict_1.default.equal(harness.activity.attempts[0]?.status, 'BLOCKED');
    strict_1.default.equal(harness.activity.attempts[0]?.operation, 'UPDATE');
});
(0, node_test_1.default)('pending gate blocks Test Connection and Connect before creating a client', async () => {
    const gate = new postgresOperationGate_1.PostgresOperationGate();
    gate.reserveForMutation('50bd58f4-1f5c-4760-822a-533013583ada');
    let factoryCalls = 0;
    const manager = new postgresConnectionManager_1.PostgresConnectionManager(() => { factoryCalls += 1; return new FakeMutationClient(); }, { findById: () => undefined }, fakeCredentials, gate);
    const request = temporaryRequest();
    await strict_1.default.rejects(() => manager.testConnection(request));
    await strict_1.default.rejects(() => manager.connect(request));
    strict_1.default.equal(factoryCalls, 0);
});
(0, node_test_1.default)('an active SELECT blocks mutation execution and other PostgreSQL interleaving', async () => {
    const harness = createHarness();
    const prepared = await harness.manager.prepareMutation(normalizedUpdate);
    const selectResult = createDeferred();
    const selectStarted = createDeferred();
    harness.client.queryImplementation = async (request) => {
        if (typeof request === 'string')
            return { rows: [] };
        selectStarted.resolve();
        return selectResult.promise;
    };
    const runner = {
        start: (client, config) => ({
            result: client.query(config),
            requestCancel: () => Promise.reject(new Error('not used')),
        }),
    };
    const selectService = new postgresQueryExecutionService_1.PostgresQueryExecutionService(harness.provider, { validateSelect: async () => ({ normalizedSql: 'SELECT 1', executableSql: 'SELECT 1' }) }, harness.activity, harness.gate, runner);
    const metadataService = new postgresMetadataService_1.PostgresMetadataService(harness.provider);
    const execution = selectService.executeSelect('SELECT 1');
    await selectStarted.promise;
    await strict_1.default.rejects(() => harness.manager.prepareMutation(normalizedUpdate), mutationTransactionManager_1.MutationTransactionError);
    await strict_1.default.rejects(() => harness.manager.executeMutation(prepared.preparationId), mutationTransactionManager_1.MutationTransactionError);
    await strict_1.default.rejects(() => metadataService.listSchemas());
    strict_1.default.equal(harness.client.requests.includes(normalizedUpdate), false);
    selectResult.resolve({ rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }] });
    await execution;
    strict_1.default.equal(harness.gate.hasActiveSelect(), false);
});
(0, node_test_1.default)('disconnect during SELECT cancels, rolls back, then closes the permanent client', async () => {
    const harness = await createConnectionManagerHarness();
    const selectResult = createDeferred();
    const selectStarted = createDeferred();
    const cancelSent = createDeferred();
    harness.client.queryImplementation = async (request) => {
        if (typeof request === 'string')
            return { rows: [] };
        selectStarted.resolve();
        return selectResult.promise;
    };
    const runner = {
        start: (client, config) => ({
            result: client.query(config),
            requestCancel: async () => { cancelSent.resolve(); },
        }),
    };
    const selectService = new postgresQueryExecutionService_1.PostgresQueryExecutionService(harness.connectionManager, { validateSelect: async () => ({ normalizedSql: 'SELECT pg_sleep(10)', executableSql: 'SELECT pg_sleep(10)' }) }, harness.activity, harness.gate, runner);
    harness.connectionManager.setBeforeDisconnectHandler(async () => {
        await selectService.cancelBeforeDisconnect();
        await harness.manager.rollbackBeforeDisconnect();
    });
    const execution = selectService.executeSelect('SELECT pg_sleep(10)');
    await selectStarted.promise;
    const disconnect = harness.connectionManager.disconnect();
    await cancelSent.promise;
    await new Promise((resolve) => setImmediate(resolve));
    selectResult.reject(Object.assign(new Error('raw cancel detail'), { code: '57014' }));
    await strict_1.default.rejects(execution, (error) => error instanceof postgresQueryExecutionService_1.QueryExecutionError
        && error.details.kind === 'CANCELLED');
    await disconnect;
    strict_1.default.ok(harness.client.lifecycle.indexOf('ROLLBACK;') < harness.client.lifecycle.indexOf('END'));
    strict_1.default.equal(harness.connectionManager.getConnectionState().status, 'DISCONNECTED');
    strict_1.default.equal(harness.gate.hasActiveSelect(), false);
    strict_1.default.equal(harness.activity.attempts.at(-1)?.status, 'CANCELLED');
});
function createHarness() {
    const gate = new postgresOperationGate_1.PostgresOperationGate();
    const client = new FakeMutationClient();
    const provider = new GateAwareProvider(client, gate);
    const safety = new FakeMutationSafety();
    const activity = new RecordingActivity();
    const timer = new FakeTimer();
    const manager = new mutationTransactionManager_1.MutationTransactionManager(provider, safety, gate, activity, timer);
    return { activity, client, gate, manager, provider, safety, timer };
}
async function prepareAndExecute(harness) {
    const preparation = await harness.manager.prepareMutation(normalizedUpdate);
    return harness.manager.executeMutation(preparation.preparationId);
}
async function createConnectionManagerHarness() {
    const gate = new postgresOperationGate_1.PostgresOperationGate();
    const client = new FakeMutationClient();
    const connectionManager = new postgresConnectionManager_1.PostgresConnectionManager(() => client, { findById: () => undefined }, fakeCredentials, gate);
    await connectionManager.connect(temporaryRequest());
    const safety = new FakeMutationSafety();
    const activity = new RecordingActivity();
    const timer = new FakeTimer();
    const manager = new mutationTransactionManager_1.MutationTransactionManager(connectionManager, safety, gate, activity, timer);
    connectionManager.setBeforeDisconnectHandler(() => manager.rollbackBeforeDisconnect());
    return { activity, client, connectionManager, gate, manager, provider: connectionManager, safety, timer };
}
const fakeCredentials = {
    isEncryptionAvailable: () => false,
    encrypt: () => Buffer.alloc(0),
    decrypt: () => '',
};
function temporaryRequest() {
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
function createDeferred() {
    let resolvePromise = () => undefined;
    let rejectPromise = () => undefined;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}
