"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const editorLoadPolicy_1 = require("../src/editorLoadPolicy");
const savedQueryUi_1 = require("../src/savedQueryUi");
const savedQuery = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Open tickets',
    description: 'Support queue',
    sqlText: 'SELECT id FROM support.tickets;',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
};
(0, node_test_1.default)('Save query is unavailable when the SQL Editor is empty', () => {
    strict_1.default.equal((0, savedQueryUi_1.isSaveQueryAvailable)(''), false);
    strict_1.default.equal((0, savedQueryUi_1.isSaveQueryAvailable)(' \n\t'), false);
    strict_1.default.equal((0, savedQueryUi_1.openSaveQueryDialog)(' \n').status, 'closed');
});
(0, node_test_1.default)('non-empty SQL opens a Save query dialog for the current Editor contents', () => {
    const state = (0, savedQueryUi_1.openSaveQueryDialog)('  SELECT 1;\n');
    strict_1.default.deepEqual(state, { status: 'open', sqlText: '  SELECT 1;\n' });
});
(0, node_test_1.default)('an empty saved query name is rejected before calling the API', async () => {
    let createCalls = 0;
    const api = createApi(async () => {
        createCalls += 1;
        return { ok: true, data: savedQuery };
    });
    const result = await (0, savedQueryUi_1.saveEditorQuery)(api, { status: 'open', sqlText: 'SELECT 1;' }, { name: '  ', description: '' }, () => undefined);
    strict_1.default.deepEqual(result, { ok: false, error: 'Saved query name is required.' });
    strict_1.default.equal(createCalls, 0);
});
(0, node_test_1.default)('Save uses the existing API with name, description, and exact Editor SQL', async () => {
    const calls = [];
    const api = createApi(async (input) => {
        calls.push(input);
        return { ok: true, data: savedQuery };
    });
    await (0, savedQueryUi_1.saveEditorQuery)(api, { status: 'open', sqlText: '  SELECT id FROM support.tickets;\n' }, { name: ' Open tickets ', description: ' Support queue ' }, () => undefined);
    strict_1.default.deepEqual(calls, [{
            name: 'Open tickets',
            description: 'Support queue',
            sqlText: '  SELECT id FROM support.tickets;\n',
        }]);
});
(0, node_test_1.default)('successful Save requests a Saved Queries list refresh', async () => {
    let refreshRequests = 0;
    const api = createApi(async () => ({ ok: true, data: savedQuery }));
    const result = await (0, savedQueryUi_1.saveEditorQuery)(api, { status: 'open', sqlText: 'SELECT 1;' }, { name: 'One', description: '' }, () => { refreshRequests += 1; });
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(refreshRequests, 1);
});
(0, node_test_1.default)('loading a Saved Query changes the Editor but never executes SQL', () => {
    let editorSql = '';
    const executeCalls = 0;
    const request = (0, editorLoadPolicy_1.prepareEditorLoad)('SELECT saved;', editorSql, 'saved query');
    (0, editorLoadPolicy_1.commitEditorLoad)(request, (sqlText) => { editorSql = sqlText; });
    strict_1.default.equal(editorSql, 'SELECT saved;');
    strict_1.default.equal(executeCalls, 0);
    void executeCalls;
});
(0, node_test_1.default)('loading a Saved Query into a non-empty Editor requires Replace confirmation', () => {
    const request = (0, editorLoadPolicy_1.prepareEditorLoad)('SELECT saved;', 'SELECT existing;', 'saved query');
    strict_1.default.equal(request.requiresConfirmation, true);
});
(0, node_test_1.default)('cancelling Saved Query replacement does not change the Editor', () => {
    const editorSql = 'SELECT existing;';
    const request = (0, editorLoadPolicy_1.prepareEditorLoad)('SELECT saved;', editorSql, 'saved query');
    strict_1.default.equal(request.requiresConfirmation, true);
    strict_1.default.equal(editorSql, 'SELECT existing;');
});
function createApi(createSavedQuery) {
    return { createSavedQuery };
}
