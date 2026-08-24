import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DatabaseColumn,
  DatabaseObject,
  PostgresMetadataApi,
} from '../shared/databaseMetadata';
import { DatabaseExplorerController } from '../src/databaseExplorerController';

const oldObject: DatabaseObject = { schema: 'public', name: 'accounts', type: 'TABLE' };
const oldColumn: DatabaseColumn = {
  schema: 'public',
  objectName: 'accounts',
  name: 'id',
  dataType: 'integer',
  nullable: false,
  ordinalPosition: 1,
  nativeType: 'int4',
};

test('Scenario G: disconnect clears the complete explorer cache and selection', async () => {
  const api = createMetadataApi();
  const controller = new DatabaseExplorerController(api);

  await controller.activate('session-a');
  await controller.toggleSchema('public');
  controller.toggleGroup('public', 'TABLE');
  await controller.selectObject(oldObject);
  assert.equal(controller.getSelection()?.columns[0]?.name, 'id');

  controller.disconnect();

  const state = controller.getSnapshot();
  assert.equal(state.sessionKey, undefined);
  assert.deepEqual(state.schemas.data, []);
  assert.deepEqual(state.objectsBySchema, {});
  assert.deepEqual(state.columnsByObject, {});
  assert.deepEqual(state.expandedSchemas, []);
  assert.deepEqual(state.expandedGroups, []);
  assert.deepEqual(state.expandedObjects, []);
  assert.equal(state.selectedObject, undefined);
});

test('Scenario H: reconnect discards the old tree and ignores its late column response', async () => {
  const deferredColumns = createDeferred<{ ok: true; data: DatabaseColumn[] }>();
  let schemaCalls = 0;
  const api: PostgresMetadataApi = {
    listSchemas: async () => ({
      ok: true,
      data: schemaCalls++ === 0 ? [{ name: 'public' }] : [{ name: 'new_schema' }],
    }),
    listSchemaObjects: async () => ({ ok: true, data: [oldObject] }),
    listColumns: () => deferredColumns.promise,
  };
  const controller = new DatabaseExplorerController(api);

  await controller.activate('session-a');
  await controller.toggleSchema('public');
  const staleLoad = controller.selectObject(oldObject);
  await controller.activate('session-b');
  deferredColumns.resolve({ ok: true, data: [oldColumn] });
  await staleLoad;

  const state = controller.getSnapshot();
  assert.equal(state.sessionKey, 'session-b');
  assert.deepEqual(state.schemas.data, [{ name: 'new_schema' }]);
  assert.deepEqual(state.objectsBySchema, {});
  assert.deepEqual(state.columnsByObject, {});
  assert.equal(state.selectedObject, undefined);
});

test('Scenario I: manual refresh reloads schemas and closes all old branches', async () => {
  let schemaCalls = 0;
  const api = createMetadataApi(() => { schemaCalls += 1; });
  const controller = new DatabaseExplorerController(api);

  await controller.activate('session-a');
  await controller.toggleSchema('public');
  controller.toggleGroup('public', 'TABLE');
  await controller.selectObject(oldObject);
  await controller.refresh();

  const state = controller.getSnapshot();
  assert.equal(schemaCalls, 2);
  assert.equal(state.sessionKey, 'session-a');
  assert.deepEqual(state.schemas.data, [{ name: 'public' }]);
  assert.deepEqual(state.objectsBySchema, {});
  assert.deepEqual(state.columnsByObject, {});
  assert.deepEqual(state.expandedSchemas, []);
  assert.deepEqual(state.expandedGroups, []);
  assert.deepEqual(state.expandedObjects, []);
  assert.equal(state.selectedObject, undefined);
});

function createMetadataApi(onListSchemas?: () => void): PostgresMetadataApi {
  return {
    listSchemas: async () => {
      onListSchemas?.();
      return { ok: true, data: [{ name: 'public' }] };
    },
    listSchemaObjects: async () => ({ ok: true, data: [oldObject] }),
    listColumns: async () => ({ ok: true, data: [oldColumn] }),
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
