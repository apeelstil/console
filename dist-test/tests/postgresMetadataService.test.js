"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const postgresConnectionManager_1 = require("../electron/postgres/postgresConnectionManager");
const postgresMetadataService_1 = require("../electron/postgres/postgresMetadataService");
class FakeMetadataClient {
    requests = [];
    responses = [];
    queryError;
    async connect() { }
    async query(request) {
        this.requests.push(request);
        if (this.queryError)
            throw this.queryError;
        return { rows: this.responses.shift() ?? [] };
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
    async withActiveClient(operation) {
        if (!this.connected)
            throw new postgresConnectionManager_1.ConnectionManagerError('No active database connection.');
        return operation(this.client);
    }
}
(0, node_test_1.default)('Scenario A: schema metadata excludes system schemas and is sorted', async () => {
    const { client, service } = createHarness();
    client.responses.push([
        { name: 'z_support' },
        { name: 'pg_temp_3' },
        { name: 'public' },
        { name: 'information_schema' },
        { name: 'pg_catalog' },
    ]);
    const schemas = await service.listSchemas();
    strict_1.default.deepEqual(schemas, [{ name: 'public' }, { name: 'z_support' }]);
    const request = asQueryConfig(client.requests[0]);
    strict_1.default.match(request.text, /information_schema\.schemata/);
    strict_1.default.match(request.text, /left\(schema_name, 3\) <> 'pg_'/);
    strict_1.default.equal(request.query_timeout, 10_000);
});
(0, node_test_1.default)('Scenario B: tables and views are mapped to narrow DTOs', async () => {
    const { client, service } = createHarness();
    client.responses.push([
        { schema_name: 'support', object_name: 'z_view', table_type: 'VIEW' },
        { schema_name: 'support', object_name: 'accounts', table_type: 'BASE TABLE' },
    ]);
    const objects = await service.listSchemaObjects('support');
    strict_1.default.deepEqual(objects, [
        { schema: 'support', name: 'accounts', type: 'TABLE' },
        { schema: 'support', name: 'z_view', type: 'VIEW' },
    ]);
    strict_1.default.deepEqual(asQueryConfig(client.requests[0]).values, ['support']);
});
(0, node_test_1.default)('Scenario C: columns include type, nullability, ordinal, and native type', async () => {
    const { client, service } = createHarness();
    client.responses.push([
        { schema_name: 'support', object_name: 'accounts', column_name: 'display_name', data_type: 'text', is_nullable: 'YES', ordinal_position: 2, udt_name: 'text' },
        { schema_name: 'support', object_name: 'accounts', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', ordinal_position: 1, udt_name: 'uuid' },
    ]);
    const columns = await service.listColumns('support', 'accounts');
    strict_1.default.deepEqual(columns, [
        { schema: 'support', objectName: 'accounts', name: 'id', dataType: 'uuid', nullable: false, ordinalPosition: 1, nativeType: 'uuid' },
        { schema: 'support', objectName: 'accounts', name: 'display_name', dataType: 'text', nullable: true, ordinalPosition: 2, nativeType: 'text' },
    ]);
});
(0, node_test_1.default)('Scenario D: schema and object identifiers are query parameters, never SQL fragments', async () => {
    const { client, service } = createHarness();
    const schema = "public'; DROP SCHEMA public; --";
    const objectName = "users'; SELECT secret; --";
    client.responses.push([], []);
    await service.listSchemaObjects(schema);
    await service.listColumns(schema, objectName);
    const objectsRequest = asQueryConfig(client.requests[0]);
    const columnsRequest = asQueryConfig(client.requests[1]);
    strict_1.default.deepEqual(objectsRequest.values, [schema]);
    strict_1.default.deepEqual(columnsRequest.values, [schema, objectName]);
    strict_1.default.equal(objectsRequest.text.includes(schema), false);
    strict_1.default.equal(columnsRequest.text.includes(schema), false);
    strict_1.default.equal(columnsRequest.text.includes(objectName), false);
    strict_1.default.match(objectsRequest.text, /table_schema = \$1/);
    strict_1.default.match(columnsRequest.text, /table_name = \$2/);
});
(0, node_test_1.default)('Scenario E: a metadata request without an active connection returns a safe error', async () => {
    const { provider, service } = createHarness();
    provider.connected = false;
    await strict_1.default.rejects(() => service.listSchemas(), (error) => error instanceof postgresMetadataService_1.MetadataServiceError
        && error.safeMessage === 'No active database connection.');
});
(0, node_test_1.default)('Scenario F: a permission error is safe and does not disconnect the active client', async () => {
    const { client, provider, service } = createHarness();
    client.queryError = Object.assign(new Error('raw restricted relation detail'), { code: '42501' });
    await strict_1.default.rejects(() => service.listSchemas(), (error) => error instanceof postgresMetadataService_1.MetadataServiceError
        && error.safeMessage === 'Permission denied while loading database metadata.'
        && !error.safeMessage.includes('restricted relation'));
    strict_1.default.equal(provider.connected, true);
    client.queryError = undefined;
    client.responses.push([{ name: 'public' }]);
    strict_1.default.deepEqual(await service.listSchemas(), [{ name: 'public' }]);
});
function createHarness() {
    const client = new FakeMetadataClient();
    const provider = new FakeActiveClientProvider(client);
    return { client, provider, service: new postgresMetadataService_1.PostgresMetadataService(provider) };
}
function asQueryConfig(request) {
    strict_1.default.equal(typeof request, 'object');
    return request;
}
