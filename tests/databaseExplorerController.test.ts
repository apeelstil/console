import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DatabaseColumn,
  DatabaseMetadataSearchResult,
  DatabaseObject,
  PostgresMetadataApi,
} from '../shared/databaseMetadata';
import {
  DATABASE_SEARCH_DEBOUNCE_MS,
  DatabaseExplorerController,
} from '../src/databaseExplorerController';

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
    searchDatabaseMetadata: async () => ({ ok: true, data: [] }),
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

test('search enforces minimum length and limit while an empty query preserves the lazy tree', async () => {
  assert.equal(DATABASE_SEARCH_DEBOUNCE_MS, 300);
  let searchCalls = 0;
  const api = createMetadataApi();
  api.searchDatabaseMetadata = async () => {
    searchCalls += 1;
    return {
      ok: true,
      data: Array.from({ length: 105 }, (_, index): DatabaseMetadataSearchResult => ({
        type: 'TABLE',
        schema: 'public',
        objectName: `account_${index}`,
        objectType: 'TABLE',
      })),
    };
  };
  const controller = new DatabaseExplorerController(api, 0);
  await controller.activate('session-a');
  await controller.toggleSchema('public');
  const lazyObjects = controller.getSnapshot().objectsBySchema;

  await controller.searchMetadata('');
  assert.equal(searchCalls, 0);
  assert.equal(controller.getSnapshot().search.query, '');
  assert.equal(controller.getSnapshot().objectsBySchema, lazyObjects);

  await controller.searchMetadata('a');
  assert.equal(searchCalls, 0);
  assert.equal(controller.getSnapshot().search.status, 'idle');

  await controller.searchMetadata('ac');
  assert.equal(searchCalls, 1);
  assert.equal(controller.getSnapshot().search.status, 'loaded');
  assert.equal(controller.getSnapshot().search.data.length, 100);
  assert.equal(controller.getSnapshot().objectsBySchema, lazyObjects);
});

test('a stale metadata search response cannot replace a newer result', async () => {
  const first = createDeferred<{ ok: true; data: DatabaseMetadataSearchResult[] }>();
  const second = createDeferred<{ ok: true; data: DatabaseMetadataSearchResult[] }>();
  const api = createMetadataApi();
  api.searchDatabaseMetadata = (term) => term === 'old' ? first.promise : second.promise;
  const controller = new DatabaseExplorerController(api, 0);
  await controller.activate('session-a');

  const oldSearch = controller.searchMetadata('old');
  const newSearch = controller.searchMetadata('new');
  second.resolve({ ok: true, data: [{ type: 'VIEW', schema: 'public', objectName: 'new_view', objectType: 'VIEW' }] });
  await newSearch;
  first.resolve({ ok: true, data: [{ type: 'TABLE', schema: 'public', objectName: 'old_table', objectType: 'TABLE' }] });
  await oldSearch;

  const state = controller.getSnapshot().search;
  assert.equal(state.query, 'new');
  assert.deepEqual(state.data, [{ type: 'VIEW', schema: 'public', objectName: 'new_view', objectType: 'VIEW' }]);
});

test('debounce coalesces rapid input into one PostgreSQL metadata request', async () => {
  const terms: string[] = [];
  const api = createMetadataApi();
  api.searchDatabaseMetadata = async (term) => {
    terms.push(term);
    return { ok: true, data: [] };
  };
  const controller = new DatabaseExplorerController(api, 10);
  await controller.activate('session-a');

  await Promise.all([
    controller.searchMetadata('or'),
    controller.searchMetadata('orde'),
    controller.searchMetadata('order'),
  ]);

  assert.deepEqual(terms, ['order']);
});

test('selecting a search result reveals the lazy object and loads only its columns', async () => {
  const api = createMetadataApi();
  let objectCalls = 0;
  let columnCalls = 0;
  api.listSchemaObjects = async () => {
    objectCalls += 1;
    return { ok: true, data: [oldObject] };
  };
  api.listColumns = async () => {
    columnCalls += 1;
    return { ok: true, data: [oldColumn] };
  };
  api.searchDatabaseMetadata = async () => ({
    ok: true,
    data: [{ type: 'COLUMN', schema: 'public', objectName: 'accounts', objectType: 'TABLE', columnName: 'id', dataType: 'integer' }],
  });
  const controller = new DatabaseExplorerController(api, 0);
  await controller.activate('session-a');
  await controller.searchMetadata('id');
  const result = controller.getSnapshot().search.data[0];
  assert.ok(result);

  await controller.revealSearchResult(result);

  assert.equal(objectCalls, 1);
  assert.equal(columnCalls, 1);
  assert.deepEqual(controller.getSelection(), { object: oldObject, columns: [oldColumn] });
  assert.equal(controller.getSnapshot().search.query, '');
  assert.equal(controller.getSnapshot().expandedSchemas.includes(JSON.stringify('public')), true);
  assert.equal(controller.getSnapshot().expandedGroups.includes(JSON.stringify(['public', 'TABLE'])), true);
  assert.equal(controller.getSnapshot().expandedObjects.includes(JSON.stringify(['public', 'accounts'])), true);
});

function createMetadataApi(onListSchemas?: () => void): PostgresMetadataApi {
  return {
    listSchemas: async () => {
      onListSchemas?.();
      return { ok: true, data: [{ name: 'public' }] };
    },
    listSchemaObjects: async () => ({ ok: true, data: [oldObject] }),
    listColumns: async () => ({ ok: true, data: [oldColumn] }),
    searchDatabaseMetadata: async () => ({ ok: true, data: [] }),
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
