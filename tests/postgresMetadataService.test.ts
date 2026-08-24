import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectionManagerError,
  type PostgresClient,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from '../electron/postgres/postgresConnectionManager';
import {
  MetadataServiceError,
  PostgresMetadataService,
  type ActiveClientProvider,
} from '../electron/postgres/postgresMetadataService';

class FakeMetadataClient implements PostgresClient {
  readonly requests: Array<string | PostgresQueryConfig> = [];
  readonly responses: unknown[][] = [];
  queryError?: Error & { code?: string };

  async connect(): Promise<void> {}

  async query(request: string | PostgresQueryConfig): Promise<PostgresQueryResult> {
    this.requests.push(request);
    if (this.queryError) throw this.queryError;
    return { rows: this.responses.shift() ?? [] };
  }

  async end(): Promise<void> {}

  on(_event: 'error' | 'end', _listener: ((error: Error) => void) | (() => void)): this {
    void _event;
    void _listener;
    return this;
  }
}

class FakeActiveClientProvider implements ActiveClientProvider {
  connected = true;

  constructor(readonly client: FakeMetadataClient) {}

  async withActiveClient<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.connected) throw new ConnectionManagerError('Нет активного подключения к базе данных.');
    return operation(this.client);
  }
}

test('Scenario A: schema metadata excludes system schemas and is sorted', async () => {
  const { client, service } = createHarness();
  client.responses.push([
    { name: 'z_support' },
    { name: 'pg_temp_3' },
    { name: 'public' },
    { name: 'information_schema' },
    { name: 'pg_catalog' },
  ]);

  const schemas = await service.listSchemas();

  assert.deepEqual(schemas, [{ name: 'public' }, { name: 'z_support' }]);
  const request = asQueryConfig(client.requests[0]);
  assert.match(request.text, /information_schema\.schemata/);
  assert.match(request.text, /left\(schema_name, 3\) <> 'pg_'/);
  assert.equal(request.query_timeout, 10_000);
});

test('Scenario B: tables and views are mapped to narrow DTOs', async () => {
  const { client, service } = createHarness();
  client.responses.push([
    { schema_name: 'support', object_name: 'z_view', table_type: 'VIEW' },
    { schema_name: 'support', object_name: 'accounts', table_type: 'BASE TABLE' },
  ]);

  const objects = await service.listSchemaObjects('support');

  assert.deepEqual(objects, [
    { schema: 'support', name: 'accounts', type: 'TABLE' },
    { schema: 'support', name: 'z_view', type: 'VIEW' },
  ]);
  assert.deepEqual(asQueryConfig(client.requests[0]).values, ['support']);
});

test('Scenario C: columns include type, nullability, ordinal, and native type', async () => {
  const { client, service } = createHarness();
  client.responses.push([
    { schema_name: 'support', object_name: 'accounts', column_name: 'display_name', data_type: 'text', is_nullable: 'YES', ordinal_position: 2, udt_name: 'text' },
    { schema_name: 'support', object_name: 'accounts', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', ordinal_position: 1, udt_name: 'uuid' },
  ]);

  const columns = await service.listColumns('support', 'accounts');

  assert.deepEqual(columns, [
    { schema: 'support', objectName: 'accounts', name: 'id', dataType: 'uuid', nullable: false, ordinalPosition: 1, nativeType: 'uuid' },
    { schema: 'support', objectName: 'accounts', name: 'display_name', dataType: 'text', nullable: true, ordinalPosition: 2, nativeType: 'text' },
  ]);
});

test('Scenario D: schema and object identifiers are query parameters, never SQL fragments', async () => {
  const { client, service } = createHarness();
  const schema = "public'; DROP SCHEMA public; --";
  const objectName = "users'; SELECT secret; --";
  client.responses.push([], []);

  await service.listSchemaObjects(schema);
  await service.listColumns(schema, objectName);

  const objectsRequest = asQueryConfig(client.requests[0]);
  const columnsRequest = asQueryConfig(client.requests[1]);
  assert.deepEqual(objectsRequest.values, [schema]);
  assert.deepEqual(columnsRequest.values, [schema, objectName]);
  assert.equal(objectsRequest.text.includes(schema), false);
  assert.equal(columnsRequest.text.includes(schema), false);
  assert.equal(columnsRequest.text.includes(objectName), false);
  assert.match(objectsRequest.text, /table_schema = \$1/);
  assert.match(columnsRequest.text, /table_name = \$2/);
});

test('Scenario E: a metadata request without an active connection returns a safe error', async () => {
  const { provider, service } = createHarness();
  provider.connected = false;

  await assert.rejects(
    () => service.listSchemas(),
    (error: unknown) => error instanceof MetadataServiceError
      && error.safeMessage === 'Нет активного подключения к базе данных.',
  );
});

test('Scenario F: a permission error is safe and does not disconnect the active client', async () => {
  const { client, provider, service } = createHarness();
  client.queryError = Object.assign(new Error('raw restricted relation detail'), { code: '42501' });

  await assert.rejects(
    () => service.listSchemas(),
    (error: unknown) => error instanceof MetadataServiceError
      && error.safeMessage === 'Недостаточно прав для загрузки метаданных базы данных.'
      && !error.safeMessage.includes('restricted relation'),
  );
  assert.equal(provider.connected, true);

  client.queryError = undefined;
  client.responses.push([{ name: 'public' }]);
  assert.deepEqual(await service.listSchemas(), [{ name: 'public' }]);
});

function createHarness() {
  const client = new FakeMetadataClient();
  const provider = new FakeActiveClientProvider(client);
  return { client, provider, service: new PostgresMetadataService(provider) };
}

function asQueryConfig(request: string | PostgresQueryConfig | undefined): PostgresQueryConfig {
  assert.equal(typeof request, 'object');
  return request as PostgresQueryConfig;
}
