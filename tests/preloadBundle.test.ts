import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const preloadPath = path.resolve(process.cwd(), 'dist-electron/electron/preload.js');
const preloadSource = readFileSync(preloadPath, 'utf8');
const expectedApiMethods = [
  'cancelSelect',
  'commitMutation',
  'connect',
  'createProfile',
  'createSavedQuery',
  'deleteProfile',
  'deleteSavedQuery',
  'disconnect',
  'executeMutation',
  'executeSelect',
  'getConnectionState',
  'getMutationState',
  'getPlatform',
  'getQueryOperationState',
  'listAuditLog',
  'listColumns',
  'listProfiles',
  'listQueryHistory',
  'listSavedQueries',
  'listSchemaObjects',
  'listSchemas',
  'onConnectionStateChanged',
  'onMutationStateChanged',
  'onQueryOperationStateChanged',
  'prepareMutation',
  'rollbackMutation',
  'testConnection',
  'updateProfile',
  'updateSavedQuery',
].sort();

test('sandboxed preload has no local runtime require calls', () => {
  const requiredModules = Array.from(
    preloadSource.matchAll(/require\(["']([^"']+)["']\)/g),
    (match) => match[1],
  );
  assert.deepEqual(requiredModules, ['electron']);
});

test('bundled preload exposes the complete narrow renderer API', () => {
  let exposedName: string | undefined;
  let exposedApi: Record<string, unknown> | undefined;
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
        exposedName = name;
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke: () => Promise.resolve(undefined),
      on: () => undefined,
      removeListener: () => undefined,
    },
  };
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    exports: moduleObject.exports,
    module: moduleObject,
    require: (specifier: string): unknown => {
      assert.equal(specifier, 'electron');
      return electronStub;
    },
  });

  new vm.Script(preloadSource, { filename: preloadPath }).runInContext(context);

  assert.equal(exposedName, 'supraDesktop');
  assert.ok(exposedApi);
  assert.deepEqual(Object.keys(exposedApi).sort(), expectedApiMethods);
  for (const method of expectedApiMethods) assert.equal(typeof exposedApi[method], 'function');
});
