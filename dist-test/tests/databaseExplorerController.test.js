"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const databaseExplorerController_1 = require("../src/databaseExplorerController");
const oldObject = { schema: 'public', name: 'accounts', type: 'TABLE' };
const oldColumn = {
    schema: 'public',
    objectName: 'accounts',
    name: 'id',
    dataType: 'integer',
    nullable: false,
    ordinalPosition: 1,
    nativeType: 'int4',
};
(0, node_test_1.default)('Scenario G: disconnect clears the complete explorer cache and selection', async () => {
    const api = createMetadataApi();
    const controller = new databaseExplorerController_1.DatabaseExplorerController(api);
    await controller.activate('session-a');
    await controller.toggleSchema('public');
    controller.toggleGroup('public', 'TABLE');
    await controller.selectObject(oldObject);
    strict_1.default.equal(controller.getSelection()?.columns[0]?.name, 'id');
    controller.disconnect();
    const state = controller.getSnapshot();
    strict_1.default.equal(state.sessionKey, undefined);
    strict_1.default.deepEqual(state.schemas.data, []);
    strict_1.default.deepEqual(state.objectsBySchema, {});
    strict_1.default.deepEqual(state.columnsByObject, {});
    strict_1.default.deepEqual(state.expandedSchemas, []);
    strict_1.default.deepEqual(state.expandedGroups, []);
    strict_1.default.deepEqual(state.expandedObjects, []);
    strict_1.default.equal(state.selectedObject, undefined);
});
(0, node_test_1.default)('Scenario H: reconnect discards the old tree and ignores its late column response', async () => {
    const deferredColumns = createDeferred();
    let schemaCalls = 0;
    const api = {
        listSchemas: async () => ({
            ok: true,
            data: schemaCalls++ === 0 ? [{ name: 'public' }] : [{ name: 'new_schema' }],
        }),
        listSchemaObjects: async () => ({ ok: true, data: [oldObject] }),
        listColumns: () => deferredColumns.promise,
    };
    const controller = new databaseExplorerController_1.DatabaseExplorerController(api);
    await controller.activate('session-a');
    await controller.toggleSchema('public');
    const staleLoad = controller.selectObject(oldObject);
    await controller.activate('session-b');
    deferredColumns.resolve({ ok: true, data: [oldColumn] });
    await staleLoad;
    const state = controller.getSnapshot();
    strict_1.default.equal(state.sessionKey, 'session-b');
    strict_1.default.deepEqual(state.schemas.data, [{ name: 'new_schema' }]);
    strict_1.default.deepEqual(state.objectsBySchema, {});
    strict_1.default.deepEqual(state.columnsByObject, {});
    strict_1.default.equal(state.selectedObject, undefined);
});
(0, node_test_1.default)('Scenario I: manual refresh reloads schemas and closes all old branches', async () => {
    let schemaCalls = 0;
    const api = createMetadataApi(() => { schemaCalls += 1; });
    const controller = new databaseExplorerController_1.DatabaseExplorerController(api);
    await controller.activate('session-a');
    await controller.toggleSchema('public');
    controller.toggleGroup('public', 'TABLE');
    await controller.selectObject(oldObject);
    await controller.refresh();
    const state = controller.getSnapshot();
    strict_1.default.equal(schemaCalls, 2);
    strict_1.default.equal(state.sessionKey, 'session-a');
    strict_1.default.deepEqual(state.schemas.data, [{ name: 'public' }]);
    strict_1.default.deepEqual(state.objectsBySchema, {});
    strict_1.default.deepEqual(state.columnsByObject, {});
    strict_1.default.deepEqual(state.expandedSchemas, []);
    strict_1.default.deepEqual(state.expandedGroups, []);
    strict_1.default.deepEqual(state.expandedObjects, []);
    strict_1.default.equal(state.selectedObject, undefined);
});
function createMetadataApi(onListSchemas) {
    return {
        listSchemas: async () => {
            onListSchemas?.();
            return { ok: true, data: [{ name: 'public' }] };
        },
        listSchemaObjects: async () => ({ ok: true, data: [oldObject] }),
        listColumns: async () => ({ ok: true, data: [oldColumn] }),
    };
}
function createDeferred() {
    let resolvePromise = () => undefined;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    return { promise, resolve: resolvePromise };
}
