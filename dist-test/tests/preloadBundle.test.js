"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importDefault(require("node:test"));
const node_vm_1 = __importDefault(require("node:vm"));
const preloadPath = node_path_1.default.resolve(process.cwd(), 'dist-electron/electron/preload.js');
const preloadSource = (0, node_fs_1.readFileSync)(preloadPath, 'utf8');
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
(0, node_test_1.default)('sandboxed preload has no local runtime require calls', () => {
    const requiredModules = Array.from(preloadSource.matchAll(/require\(["']([^"']+)["']\)/g), (match) => match[1]);
    strict_1.default.deepEqual(requiredModules, ['electron']);
});
(0, node_test_1.default)('bundled preload exposes the complete narrow renderer API', () => {
    let exposedName;
    let exposedApi;
    const electronStub = {
        contextBridge: {
            exposeInMainWorld: (name, api) => {
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
    const context = node_vm_1.default.createContext({
        exports: moduleObject.exports,
        module: moduleObject,
        require: (specifier) => {
            strict_1.default.equal(specifier, 'electron');
            return electronStub;
        },
    });
    new node_vm_1.default.Script(preloadSource, { filename: preloadPath }).runInContext(context);
    strict_1.default.equal(exposedName, 'supraDesktop');
    strict_1.default.ok(exposedApi);
    strict_1.default.deepEqual(Object.keys(exposedApi).sort(), expectedApiMethods);
    for (const method of expectedApiMethods)
        strict_1.default.equal(typeof exposedApi[method], 'function');
});
