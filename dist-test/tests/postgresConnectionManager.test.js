"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const postgresConnectionManager_1 = require("../electron/postgres/postgresConnectionManager");
const storedProfile = {
    id: 'b157d9de-6ef2-4eae-bfea-0fb44f5036d9',
    name: 'SUPRA TEST',
    host: 'test-host',
    port: 5432,
    database: 'supra_test',
    username: 'support_user',
    environment: 'TEST',
    encryptedPassword: Buffer.from('encrypted-test-password'),
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
};
const temporaryRequest = {
    source: 'temporary',
    connection: {
        name: 'Temporary test',
        host: 'temporary-host',
        port: 5432,
        database: 'temporary_database',
        username: 'temporary_user',
        environment: 'DEV',
    },
    temporaryPassword: 'temporary-password',
};
class FakeProfileProvider {
    profile;
    findCalls = 0;
    constructor(profile) {
        this.profile = profile;
    }
    findById(id) {
        this.findCalls += 1;
        return this.profile?.id === id ? this.profile : undefined;
    }
}
class FakeCredentialStorage {
    decryptedPassword;
    decryptCalls = 0;
    constructor(decryptedPassword = 'stored-password') {
        this.decryptedPassword = decryptedPassword;
    }
    isEncryptionAvailable() {
        return true;
    }
    encrypt(password) {
        return Buffer.from(password);
    }
    decrypt(encryptedPassword) {
        strict_1.default.notEqual(encryptedPassword.length, 0);
        this.decryptCalls += 1;
        return this.decryptedPassword;
    }
}
class FakePostgresClient {
    connectCalls = 0;
    endCalls = 0;
    queries = [];
    connectImplementation = async () => undefined;
    queryImplementation = async () => ({ rows: [{ '?column?': 1 }] });
    errorListeners = [];
    endListeners = [];
    async connect() {
        this.connectCalls += 1;
        return this.connectImplementation();
    }
    async query(query) {
        this.queries.push(typeof query === 'string' ? query : query.text);
        return this.queryImplementation(query);
    }
    async end() {
        this.endCalls += 1;
    }
    on(event, listener) {
        if (event === 'error')
            this.errorListeners.push(listener);
        else
            this.endListeners.push(listener);
        return this;
    }
    emitError(error) {
        for (const listener of this.errorListeners)
            listener(error);
    }
    emitEnd() {
        for (const listener of this.endListeners)
            listener();
    }
}
function createHarness(profile) {
    const clients = [];
    const configs = [];
    const profiles = new FakeProfileProvider(profile);
    const credentials = new FakeCredentialStorage();
    const manager = new postgresConnectionManager_1.PostgresConnectionManager((config) => {
        configs.push(config);
        const client = new FakePostgresClient();
        clients.push(client);
        return client;
    }, profiles, credentials);
    return { manager, clients, configs, profiles, credentials };
}
(0, node_test_1.default)('Scenario A: successful test uses a temporary Client, SELECT 1, and always closes it', async () => {
    const harness = createHarness();
    const result = await harness.manager.testConnection(temporaryRequest);
    strict_1.default.equal(result.message, 'Connection successful');
    strict_1.default.equal(harness.clients.length, 1);
    strict_1.default.equal(harness.clients[0]?.connectCalls, 1);
    strict_1.default.deepEqual(harness.clients[0]?.queries, ['SELECT 1;']);
    strict_1.default.equal(harness.clients[0]?.endCalls, 1);
    strict_1.default.equal(harness.configs[0]?.connectionTimeoutMillis, 10_000);
    strict_1.default.equal(harness.configs[0]?.keepAlive, true);
    strict_1.default.equal(harness.configs[0]?.application_name, 'SUPRA Query Console');
    strict_1.default.equal(harness.configs[0]?.ssl, undefined);
    strict_1.default.deepEqual(harness.manager.getConnectionState(), {
        status: 'DISCONNECTED',
        message: 'Connection successful',
    });
});
(0, node_test_1.default)('Scenario B: failed test returns a safe error, closes the temporary Client, and creates no active connection', async () => {
    const harness = createHarness();
    const client = new FakePostgresClient();
    const unsafePassword = 'secret-that-must-not-leak';
    client.connectImplementation = async () => {
        const error = new Error(`password authentication failed: ${unsafePassword}`);
        error.code = '28P01';
        throw error;
    };
    const manager = new postgresConnectionManager_1.PostgresConnectionManager(() => client, harness.profiles, harness.credentials);
    await strict_1.default.rejects(() => manager.testConnection(temporaryRequest), (error) => error instanceof postgresConnectionManager_1.ConnectionManagerError
        && error.safeMessage === 'Authentication failed. Check the username and password.'
        && !error.safeMessage.includes(unsafePassword));
    strict_1.default.equal(client.endCalls, 1);
    strict_1.default.equal(manager.getConnectionState().connection, undefined);
    strict_1.default.equal(manager.getConnectionState().status, 'ERROR');
});
(0, node_test_1.default)('Scenario C: permanent Connect retains one Client and exposes metadata without a password', async () => {
    const harness = createHarness();
    const state = await harness.manager.connect(temporaryRequest);
    strict_1.default.equal(harness.clients[0]?.connectCalls, 1);
    strict_1.default.equal(harness.clients[0]?.endCalls, 0);
    strict_1.default.equal(state.status, 'CONNECTED');
    strict_1.default.equal(state.connection?.database, temporaryRequest.connection.database);
    strict_1.default.equal('password' in (state.connection ?? {}), false);
    strict_1.default.equal('temporaryPassword' in state, false);
});
(0, node_test_1.default)('Scenario D: Disconnect closes and releases the active Client and is safe to repeat', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    const state = await harness.manager.disconnect();
    const repeatedState = await harness.manager.disconnect();
    strict_1.default.equal(harness.clients[0]?.endCalls, 1);
    strict_1.default.deepEqual(state, { status: 'DISCONNECTED' });
    strict_1.default.deepEqual(repeatedState, { status: 'DISCONNECTED' });
});
(0, node_test_1.default)('an active-client callback failure leaves the valid permanent connection intact', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    await strict_1.default.rejects(() => harness.manager.withActiveClient(async () => {
        throw Object.assign(new Error('metadata permission denied'), { code: '42501' });
    }));
    strict_1.default.equal(harness.manager.getConnectionState().status, 'CONNECTED');
    strict_1.default.equal(harness.clients[0]?.endCalls, 0);
    await harness.manager.disconnect();
});
(0, node_test_1.default)('active-client callbacks are serialized to prevent metadata interleaving with transactions', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    const releaseFirst = createDeferred();
    const operations = [];
    const first = harness.manager.withActiveClient(async () => {
        operations.push('first-start');
        await releaseFirst.promise;
        operations.push('first-end');
    });
    const second = harness.manager.withActiveClient(async () => {
        operations.push('second');
    });
    await new Promise((resolve) => setImmediate(resolve));
    strict_1.default.deepEqual(operations, ['first-start']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    strict_1.default.deepEqual(operations, ['first-start', 'first-end', 'second']);
    await harness.manager.disconnect();
});
(0, node_test_1.default)('Scenario E: stored credential is decrypted only inside the manager and never enters the public DTO', async () => {
    const harness = createHarness(storedProfile);
    const state = await harness.manager.connect({ source: 'profile', profileId: storedProfile.id });
    strict_1.default.equal(harness.credentials.decryptCalls, 1);
    strict_1.default.equal(harness.configs[0]?.password, 'stored-password');
    strict_1.default.equal(state.connection?.profileId, storedProfile.id);
    strict_1.default.equal('password' in (state.connection ?? {}), false);
    strict_1.default.equal(JSON.stringify(state).includes('stored-password'), false);
    await harness.manager.disconnect();
});
(0, node_test_1.default)('Scenario F: temporary unsaved password is used without accessing or modifying profile storage', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    strict_1.default.equal(harness.credentials.decryptCalls, 0);
    strict_1.default.equal(harness.configs[0]?.password, temporaryRequest.temporaryPassword);
    strict_1.default.equal(harness.profiles.findCalls, 0);
    strict_1.default.equal(JSON.stringify(harness.manager.getConnectionState()).includes(temporaryRequest.temporaryPassword), false);
    await harness.manager.disconnect();
});
(0, node_test_1.default)('a temporary password overrides a stored password without replacing it', async () => {
    const harness = createHarness(storedProfile);
    const override = 'one-time-override';
    await harness.manager.connect({ source: 'profile', profileId: storedProfile.id, temporaryPassword: override });
    strict_1.default.equal(harness.credentials.decryptCalls, 0);
    strict_1.default.equal(harness.configs[0]?.password, override);
    strict_1.default.deepEqual(storedProfile.encryptedPassword, Buffer.from('encrypted-test-password'));
    await harness.manager.disconnect();
});
(0, node_test_1.default)('Scenario G: a second parallel permanent Connect is blocked', async () => {
    const deferred = createDeferred();
    const firstClient = new FakePostgresClient();
    firstClient.connectImplementation = () => deferred.promise;
    let factoryCalls = 0;
    const manager = new postgresConnectionManager_1.PostgresConnectionManager(() => {
        factoryCalls += 1;
        return firstClient;
    }, new FakeProfileProvider(), new FakeCredentialStorage());
    const firstConnect = manager.connect(temporaryRequest);
    await strict_1.default.rejects(() => manager.connect(temporaryRequest), (error) => error instanceof postgresConnectionManager_1.ConnectionManagerError && error.safeMessage.includes('already in progress'));
    strict_1.default.equal(factoryCalls, 1);
    deferred.resolve();
    await firstConnect;
    await manager.disconnect();
});
(0, node_test_1.default)('Scenario H: unexpected Client error does not throw, clears the Client, and publishes safe ERROR state', async () => {
    const harness = createHarness();
    const states = [];
    harness.manager.subscribe((state) => states.push(state.status));
    await harness.manager.connect(temporaryRequest);
    strict_1.default.doesNotThrow(() => harness.clients[0]?.emitError(Object.assign(new Error('socket failed'), { code: 'ECONNREFUSED' })));
    await new Promise((resolve) => setImmediate(resolve));
    const state = harness.manager.getConnectionState();
    strict_1.default.equal(state.status, 'ERROR');
    strict_1.default.equal(state.connection, undefined);
    strict_1.default.equal(state.message, 'The database server refused the connection.');
    strict_1.default.equal(harness.clients[0]?.endCalls, 1);
    strict_1.default.deepEqual(states, ['CONNECTING', 'CONNECTED', 'ERROR']);
});
(0, node_test_1.default)('an unexpected Client end event clears the active connection without crashing', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    strict_1.default.doesNotThrow(() => harness.clients[0]?.emitEnd());
    const state = harness.manager.getConnectionState();
    strict_1.default.equal(state.status, 'ERROR');
    strict_1.default.equal(state.connection, undefined);
    strict_1.default.equal(state.message, 'The PostgreSQL connection was closed unexpectedly.');
    strict_1.default.equal(harness.clients[0]?.endCalls, 1);
});
(0, node_test_1.default)('connection errors are classified without returning raw details', () => {
    const secret = 'never-return-this-password';
    const cases = [
        [Object.assign(new Error(`authentication failed ${secret}`), { code: '28P01' }), 'Authentication failed. Check the username and password.'],
        [Object.assign(new Error('database missing'), { code: '3D000' }), 'The specified database does not exist.'],
        [Object.assign(new Error('dns failed'), { code: 'ENOTFOUND' }), 'The database host could not be resolved.'],
        [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'The database server refused the connection.'],
        [Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'The database server did not respond before the connection timeout.'],
        [Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }), 'The database server is unreachable.'],
        [new Error(`unknown failure ${secret}`), 'PostgreSQL connection failed. Check the connection settings and server availability.'],
    ];
    for (const [error, expected] of cases) {
        const safeMessage = (0, postgresConnectionManager_1.getSafeConnectionError)(error);
        strict_1.default.equal(safeMessage, expected);
        strict_1.default.equal(safeMessage.includes(secret), false);
    }
});
(0, node_test_1.default)('shutdown closes an active Client once and blocks future connections', async () => {
    const harness = createHarness();
    await harness.manager.connect(temporaryRequest);
    await harness.manager.shutdown();
    strict_1.default.equal(harness.clients[0]?.endCalls, 1);
    strict_1.default.equal(harness.manager.getConnectionState().status, 'DISCONNECTED');
    await strict_1.default.rejects(() => harness.manager.connect(temporaryRequest), postgresConnectionManager_1.ConnectionManagerError);
});
(0, node_test_1.default)('shutdown closes an in-flight Test Connection Client once', async () => {
    const deferred = createDeferred();
    const client = new FakePostgresClient();
    client.connectImplementation = () => deferred.promise;
    const manager = new postgresConnectionManager_1.PostgresConnectionManager(() => client, new FakeProfileProvider(), new FakeCredentialStorage());
    const testOperation = manager.testConnection(temporaryRequest);
    await manager.shutdown();
    strict_1.default.equal(client.endCalls, 1);
    deferred.resolve();
    await strict_1.default.rejects(testOperation, postgresConnectionManager_1.ConnectionManagerError);
    strict_1.default.equal(client.endCalls, 1);
});
function createDeferred() {
    let resolvePromise = () => undefined;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    return { promise, resolve: resolvePromise };
}
