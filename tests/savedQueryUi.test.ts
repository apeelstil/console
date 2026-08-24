import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalQueryDataApi, SavedQuery } from '../shared/localQueryData';
import { commitEditorLoad, prepareEditorLoad } from '../src/editorLoadPolicy';
import {
  isSaveQueryAvailable,
  openSaveQueryDialog,
  saveEditorQuery,
} from '../src/savedQueryUi';

const savedQuery: SavedQuery = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Open tickets',
  description: 'Support queue',
  sqlText: 'SELECT id FROM support.tickets;',
  createdAt: '2026-08-24T10:00:00.000Z',
  updatedAt: '2026-08-24T10:00:00.000Z',
};

test('Save query is unavailable when the SQL Editor is empty', () => {
  assert.equal(isSaveQueryAvailable(''), false);
  assert.equal(isSaveQueryAvailable(' \n\t'), false);
  assert.equal(openSaveQueryDialog(' \n').status, 'closed');
});

test('non-empty SQL opens a Save query dialog for the current Editor contents', () => {
  const state = openSaveQueryDialog('  SELECT 1;\n');

  assert.deepEqual(state, { status: 'open', sqlText: '  SELECT 1;\n' });
});

test('an empty saved query name is rejected before calling the API', async () => {
  let createCalls = 0;
  const api = createApi(async () => {
    createCalls += 1;
    return { ok: true, data: savedQuery };
  });

  const result = await saveEditorQuery(
    api,
    { status: 'open', sqlText: 'SELECT 1;' },
    { name: '  ', description: '' },
    () => undefined,
  );

  assert.deepEqual(result, { ok: false, error: 'Saved query name is required.' });
  assert.equal(createCalls, 0);
});

test('Save uses the existing API with name, description, and exact Editor SQL', async () => {
  const calls: Parameters<LocalQueryDataApi['createSavedQuery']>[0][] = [];
  const api = createApi(async (input) => {
    calls.push(input);
    return { ok: true, data: savedQuery };
  });

  await saveEditorQuery(
    api,
    { status: 'open', sqlText: '  SELECT id FROM support.tickets;\n' },
    { name: ' Open tickets ', description: ' Support queue ' },
    () => undefined,
  );

  assert.deepEqual(calls, [{
    name: 'Open tickets',
    description: 'Support queue',
    sqlText: '  SELECT id FROM support.tickets;\n',
  }]);
});

test('successful Save requests a Saved Queries list refresh', async () => {
  let refreshRequests = 0;
  const api = createApi(async () => ({ ok: true, data: savedQuery }));

  const result = await saveEditorQuery(
    api,
    { status: 'open', sqlText: 'SELECT 1;' },
    { name: 'One', description: '' },
    () => { refreshRequests += 1; },
  );

  assert.equal(result.ok, true);
  assert.equal(refreshRequests, 1);
});

test('loading a Saved Query changes the Editor but never executes SQL', () => {
  let editorSql = '';
  const executeCalls = 0;
  const request = prepareEditorLoad('SELECT saved;', editorSql, 'saved query');

  commitEditorLoad(request, (sqlText) => { editorSql = sqlText; });

  assert.equal(editorSql, 'SELECT saved;');
  assert.equal(executeCalls, 0);
  void executeCalls;
});

test('loading a Saved Query into a non-empty Editor requires Replace confirmation', () => {
  const request = prepareEditorLoad('SELECT saved;', 'SELECT existing;', 'saved query');

  assert.equal(request.requiresConfirmation, true);
});

test('cancelling Saved Query replacement does not change the Editor', () => {
  const editorSql = 'SELECT existing;';
  const request = prepareEditorLoad('SELECT saved;', editorSql, 'saved query');

  assert.equal(request.requiresConfirmation, true);
  assert.equal(editorSql, 'SELECT existing;');
});

function createApi(
  createSavedQuery: LocalQueryDataApi['createSavedQuery'],
): Pick<LocalQueryDataApi, 'createSavedQuery'> {
  return { createSavedQuery };
}
