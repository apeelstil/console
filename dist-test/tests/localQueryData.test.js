"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importStar(require("node:test"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const connectionProfileRepository_1 = require("../electron/storage/connectionProfileRepository");
const database_1 = require("../electron/storage/database");
const queryActivityRepository_1 = require("../electron/storage/queryActivityRepository");
const queryActivityService_1 = require("../electron/storage/queryActivityService");
const savedQueryRepository_1 = require("../electron/storage/savedQueryRepository");
const savedQueryService_1 = require("../electron/storage/savedQueryService");
const localQueryData_1 = require("../shared/localQueryData");
const editorLoadPolicy_1 = require("../src/editorLoadPolicy");
const testDirectory = (0, node_fs_1.mkdtempSync)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'supra-query-data-'));
let databaseSequence = 0;
(0, node_test_1.after)(() => (0, node_fs_1.rmSync)(testDirectory, { recursive: true, force: true }));
const identity = {
    getWindowsUser: () => 'TEST\\support.agent',
    getComputerName: () => 'SUPPORT-PC',
};
(0, node_test_1.default)('migration 1 through 4 preserves connection profiles and creates local query tables', () => {
    const databasePath = nextDatabasePath();
    const legacy = new better_sqlite3_1.default(databasePath);
    createVersionOneSchema(legacy);
    legacy.prepare(`
    INSERT INTO connection_profiles (
      id, name, host, port, database_name, username, environment,
      encrypted_password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('fd3175a8-6b5e-4c4e-86fb-e5ad0a823b26', 'Legacy TEST', 'legacy-host', 5432, 'legacy_db', 'legacy_user', 'TEST', Buffer.from('legacy-ciphertext'), '2026-08-24T10:00:00.000Z', '2026-08-24T10:00:00.000Z');
    legacy.close();
    const migrated = (0, database_1.initializeDatabase)(databasePath);
    const profiles = new connectionProfileRepository_1.ConnectionProfileRepository(migrated).list();
    strict_1.default.equal(migrated.pragma('user_version', { simple: true }), database_1.CURRENT_SCHEMA_VERSION);
    strict_1.default.equal(profiles.length, 1);
    strict_1.default.equal(profiles[0]?.name, 'Legacy TEST');
    strict_1.default.deepEqual(profiles[0]?.encryptedPassword, Buffer.from('legacy-ciphertext'));
    strict_1.default.deepEqual(listTables(migrated), ['audit_log', 'connection_profiles', 'query_history', 'saved_queries']);
    migrated.close();
});
(0, node_test_1.default)('databases newer than schema v4 are rejected', () => {
    const databasePath = nextDatabasePath();
    const database = new better_sqlite3_1.default(databasePath);
    database.pragma('user_version = 5');
    database.close();
    strict_1.default.throws(() => (0, database_1.initializeDatabase)(databasePath), /newer application version/);
});
(0, node_test_1.default)('migration 2 through 4 preserves existing Audit rows and enables mutation outcomes', () => {
    const databasePath = nextDatabasePath();
    const database = (0, database_1.initializeDatabase)(databasePath);
    const repository = new queryActivityRepository_1.AuditLogRepository(database);
    repository.add(auditEntry(1));
    database.pragma('user_version = 2');
    database.close();
    const migrated = (0, database_1.initializeDatabase)(databasePath);
    const migratedRepository = new queryActivityRepository_1.AuditLogRepository(migrated);
    const existing = migratedRepository.list();
    strict_1.default.equal(existing.length, 1);
    strict_1.default.equal(existing[0]?.operation, 'EXECUTE');
    migratedRepository.add({
        ...auditEntry(2),
        operation: 'UPDATE',
        outcome: 'PENDING',
    });
    strict_1.default.equal(migratedRepository.list()[0]?.outcome, 'PENDING');
    migrated.close();
});
(0, node_test_1.default)('migration 3 to 4 preserves activity and enables CANCELLED in History and Audit', async () => {
    const databasePath = nextDatabasePath();
    const database = (0, database_1.initializeDatabase)(databasePath);
    await new queryActivityService_1.LocalQueryActivityService(new queryActivityRepository_1.QueryHistoryRepository(database), new queryActivityRepository_1.AuditLogRepository(database), identity).recordAttempt(attempt('SUCCESS'));
    database.pragma('user_version = 3');
    database.close();
    const migrated = (0, database_1.initializeDatabase)(databasePath);
    const history = new queryActivityRepository_1.QueryHistoryRepository(migrated);
    const audit = new queryActivityRepository_1.AuditLogRepository(migrated);
    await new queryActivityService_1.LocalQueryActivityService(history, audit, identity).recordAttempt({
        ...attempt('CANCELLED'),
        errorCode: '57014',
        errorMessage: 'Query cancelled',
    });
    strict_1.default.deepEqual(history.list().map((entry) => entry.status).sort(), ['CANCELLED', 'SUCCESS']);
    strict_1.default.deepEqual(audit.list().map((entry) => entry.outcome).sort(), ['CANCELLED', 'SUCCESS']);
    migrated.close();
});
(0, node_test_1.default)('Saved Query CRUD persists name, description, and SQL', () => {
    const database = (0, database_1.initializeDatabase)(nextDatabasePath());
    const service = new savedQueryService_1.SavedQueryService(new savedQueryRepository_1.SavedQueryRepository(database));
    const created = service.createQuery({
        name: 'Open tickets',
        description: 'Support queue',
        sqlText: 'SELECT id FROM support.tickets;',
    });
    strict_1.default.equal(service.listQueries()[0]?.id, created.id);
    const updated = service.updateQuery({
        id: created.id,
        name: 'Open tickets today',
        description: 'Renamed description',
        sqlText: created.sqlText,
    });
    strict_1.default.equal(updated.name, 'Open tickets today');
    strict_1.default.equal(updated.description, 'Renamed description');
    service.deleteQuery(created.id);
    strict_1.default.deepEqual(service.listQueries(), []);
    database.close();
});
(0, node_test_1.default)('Saved Queries reject an empty name and empty SQL', () => {
    const database = (0, database_1.initializeDatabase)(nextDatabasePath());
    const service = new savedQueryService_1.SavedQueryService(new savedQueryRepository_1.SavedQueryRepository(database));
    strict_1.default.throws(() => service.createQuery({ name: ' ', sqlText: 'SELECT 1;' }), savedQueryService_1.SavedQueryServiceError);
    strict_1.default.throws(() => service.createQuery({ name: 'Valid name', sqlText: '\n  ' }), savedQueryService_1.SavedQueryServiceError);
    strict_1.default.equal(service.listQueries().length, 0);
    database.close();
});
(0, node_test_1.default)('Saved/History Load replaces editor text but never invokes Execute', () => {
    let editorSql = 'SELECT existing;';
    const executeCalls = 0;
    const savedRequest = (0, editorLoadPolicy_1.prepareEditorLoad)('SELECT saved;', editorSql, 'saved query');
    strict_1.default.equal(savedRequest.requiresConfirmation, true);
    (0, editorLoadPolicy_1.commitEditorLoad)(savedRequest, (sql) => { editorSql = sql; });
    strict_1.default.equal(editorSql, 'SELECT saved;');
    strict_1.default.equal(executeCalls, 0);
    const historyRequest = (0, editorLoadPolicy_1.prepareEditorLoad)('SELECT history;', '', 'history query');
    (0, editorLoadPolicy_1.commitEditorLoad)(historyRequest, (sql) => { editorSql = sql; });
    strict_1.default.equal(editorSql, 'SELECT history;');
    strict_1.default.equal(executeCalls, 0);
    void executeCalls;
});
(0, node_test_1.default)('SUCCESS, ERROR, TIMEOUT, BLOCKED, and CANCELLED are written to History and Audit', async () => {
    const database = (0, database_1.initializeDatabase)(nextDatabasePath());
    const history = new queryActivityRepository_1.QueryHistoryRepository(database);
    const audit = new queryActivityRepository_1.AuditLogRepository(database);
    const service = new queryActivityService_1.LocalQueryActivityService(history, audit, identity);
    for (const status of ['SUCCESS', 'ERROR', 'TIMEOUT', 'BLOCKED', 'CANCELLED']) {
        await service.recordAttempt({
            ...attempt(status),
            errorCode: status === 'TIMEOUT' ? '57014' : null,
            errorMessage: status === 'SUCCESS' ? null : `Safe ${status} message`,
        });
    }
    strict_1.default.deepEqual(history.list().map((entry) => entry.status).sort(), ['BLOCKED', 'CANCELLED', 'ERROR', 'SUCCESS', 'TIMEOUT']);
    strict_1.default.deepEqual(audit.list().map((entry) => entry.outcome).sort(), ['BLOCKED', 'CANCELLED', 'ERROR', 'SUCCESS', 'TIMEOUT']);
    strict_1.default.equal(audit.list().every((entry) => entry.operation === 'EXECUTE'), true);
    database.close();
});
(0, node_test_1.default)('History FIFO keeps 500 entries while Audit is never trimmed with it', () => {
    const database = (0, database_1.initializeDatabase)(nextDatabasePath());
    const history = new queryActivityRepository_1.QueryHistoryRepository(database);
    const audit = new queryActivityRepository_1.AuditLogRepository(database);
    for (let index = 0; index <= queryActivityRepository_1.QUERY_HISTORY_LIMIT; index += 1) {
        history.add(historyEntry(index));
        audit.add(auditEntry(index));
    }
    strict_1.default.equal(history.list().length, queryActivityRepository_1.QUERY_HISTORY_LIMIT);
    strict_1.default.equal(history.list().some((entry) => entry.id === uuidFor(0)), false);
    const auditCount = database.prepare('SELECT count(*) AS count FROM audit_log').get();
    strict_1.default.equal(auditCount?.count, queryActivityRepository_1.QUERY_HISTORY_LIMIT + 1);
    database.close();
});
(0, node_test_1.default)('Saved Queries, History, and Audit survive a database restart', async () => {
    const databasePath = nextDatabasePath();
    const database = (0, database_1.initializeDatabase)(databasePath);
    new savedQueryService_1.SavedQueryService(new savedQueryRepository_1.SavedQueryRepository(database)).createQuery({
        name: 'Persistent query',
        sqlText: 'SELECT 42;',
    });
    await new queryActivityService_1.LocalQueryActivityService(new queryActivityRepository_1.QueryHistoryRepository(database), new queryActivityRepository_1.AuditLogRepository(database), identity).recordAttempt(attempt('SUCCESS'));
    database.close();
    const reopened = (0, database_1.initializeDatabase)(databasePath);
    strict_1.default.equal(new savedQueryRepository_1.SavedQueryRepository(reopened).list().length, 1);
    strict_1.default.equal(new queryActivityRepository_1.QueryHistoryRepository(reopened).list().length, 1);
    strict_1.default.equal(new queryActivityRepository_1.AuditLogRepository(reopened).list().length, 1);
    reopened.close();
});
(0, node_test_1.default)('History/Audit DTOs and IPC contain no credentials or Audit mutation channel', async () => {
    const database = (0, database_1.initializeDatabase)(nextDatabasePath());
    const service = new queryActivityService_1.LocalQueryActivityService(new queryActivityRepository_1.QueryHistoryRepository(database), new queryActivityRepository_1.AuditLogRepository(database), identity);
    await service.recordAttempt(attempt('SUCCESS'));
    const serialized = JSON.stringify({ history: service.listHistory(), audit: service.listAuditLog() });
    const channelNames = Object.keys(localQueryData_1.LOCAL_QUERY_DATA_CHANNELS);
    const preloadSource = (0, node_fs_1.readFileSync)(node_path_1.default.join(process.cwd(), 'electron', 'preload.ts'), 'utf8');
    strict_1.default.equal(serialized.includes('password'), false);
    strict_1.default.equal(serialized.includes('encryptedPassword'), false);
    strict_1.default.equal(serialized.includes('connectionString'), false);
    strict_1.default.deepEqual(channelNames.filter((name) => name.toLowerCase().includes('audit')), ['listAuditLog']);
    strict_1.default.doesNotMatch(preloadSource, /(write|create|update|delete)Audit/i);
    database.close();
});
(0, node_test_1.default)('Audit storage failure is visible, secret-free, and does not prevent History', async () => {
    const history = new MemoryHistoryStore();
    const audit = new FailingAuditStore();
    const reports = [];
    const service = new queryActivityService_1.LocalQueryActivityService(history, audit, identity, (message) => reports.push(message));
    const result = await service.recordAttempt(attempt('SUCCESS'));
    strict_1.default.equal(history.entries.length, 1);
    strict_1.default.deepEqual(result.warnings, ['Audit log could not be written.']);
    strict_1.default.deepEqual(reports, ['[SUPRA] Audit log could not be written.']);
    strict_1.default.equal(JSON.stringify({ result, reports }).includes('SELECT 1'), false);
});
function nextDatabasePath() {
    databaseSequence += 1;
    return node_path_1.default.join(testDirectory, `query-data-${databaseSequence}.db`);
}
function createVersionOneSchema(database) {
    database.exec(`
    CREATE TABLE connection_profiles (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      host TEXT NOT NULL CHECK (length(trim(host)) > 0),
      port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
      database_name TEXT NOT NULL CHECK (length(trim(database_name)) > 0),
      username TEXT NOT NULL CHECK (length(trim(username)) > 0),
      environment TEXT NOT NULL CHECK (environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
      encrypted_password BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
    database.pragma('user_version = 1');
}
function listTables(database) {
    return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}
function attempt(status) {
    return {
        sqlText: 'SELECT 1;',
        connection: {
            profileId: 'a2f7b608-23cd-4ad5-987b-c15a2cb84c78',
            name: 'SUPRA TEST',
            host: 'test-host',
            port: 5432,
            database: 'supra_test',
            username: 'support_user',
            environment: 'TEST',
        },
        status,
        durationMs: 12,
        returnedRows: status === 'SUCCESS' ? 1 : null,
        truncated: false,
        errorCode: null,
        errorMessage: null,
    };
}
function historyEntry(index) {
    return {
        id: uuidFor(index),
        timestamp: new Date(index * 1000).toISOString(),
        sqlText: `SELECT ${index};`,
        profileName: 'SUPRA TEST',
        environment: 'TEST',
        host: 'test-host',
        database: 'supra_test',
        databaseUser: 'support_user',
        status: 'SUCCESS',
        durationMs: index,
        returnedRows: 1,
        truncated: false,
        errorMessage: null,
    };
}
function auditEntry(index) {
    const history = historyEntry(index);
    return {
        id: uuidFor(index),
        timestamp: history.timestamp,
        windowsUser: 'TEST\\support.agent',
        computerName: 'SUPPORT-PC',
        profileName: history.profileName,
        environment: history.environment,
        host: history.host,
        database: history.database,
        databaseUser: history.databaseUser,
        operation: 'EXECUTE',
        sqlText: history.sqlText,
        outcome: history.status,
        durationMs: history.durationMs,
        returnedRows: history.returnedRows,
        errorCode: null,
        errorMessage: null,
    };
}
function uuidFor(index) {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
class MemoryHistoryStore {
    entries = [];
    add(entry) { this.entries.push(entry); }
    list() { return this.entries; }
}
class FailingAuditStore {
    add() { throw new Error('raw SELECT 1 storage failure'); }
    list() { return []; }
}
