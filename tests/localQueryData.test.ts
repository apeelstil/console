import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { ConnectionProfileRepository } from '../electron/storage/connectionProfileRepository';
import { ConnectionProfileService } from '../electron/storage/connectionProfileService';
import {
  CURRENT_SCHEMA_VERSION,
  initializeDatabase,
  LOCAL_DATABASE_FILENAME,
} from '../electron/storage/database';
import {
  AuditLogRepository,
  QUERY_HISTORY_LIMIT,
  QueryHistoryRepository,
} from '../electron/storage/queryActivityRepository';
import {
  LocalQueryActivityService,
  type AuditIdentityProvider,
  type AuditLogStore,
  type QueryHistoryStore,
} from '../electron/storage/queryActivityService';
import { SavedQueryRepository } from '../electron/storage/savedQueryRepository';
import { SavedQueryService, SavedQueryServiceError } from '../electron/storage/savedQueryService';
import { serializeAuditExport, serializeHistoryExport } from '../electron/export/queryActivityExport';
import {
  LOCAL_QUERY_DATA_CHANNELS,
  parseQueryActivityExportRequest,
  type AuditLogEntry,
  type QueryHistoryEntry,
} from '../shared/localQueryData';
import { commitEditorLoad, prepareEditorLoad } from '../src/editorLoadPolicy';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'supra-query-data-'));
let databaseSequence = 0;

after(() => rmSync(testDirectory, { recursive: true, force: true }));

const identity: AuditIdentityProvider = {
  getWindowsUser: () => 'TEST\\support.agent',
  getComputerName: () => 'SUPPORT-PC',
};

test('migration 1 through 5 preserves profiles and removes legacy encrypted passwords without decrypting them', () => {
  const databasePath = nextDatabasePath();
  const legacy = new Database(databasePath);
  createVersionOneSchema(legacy);
  legacy.prepare(`
    INSERT INTO connection_profiles (
      id, name, host, port, database_name, username, environment,
      encrypted_password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'fd3175a8-6b5e-4c4e-86fb-e5ad0a823b26', 'Legacy TEST', 'legacy-host', 5432,
    'legacy_db', 'legacy_user', 'TEST', Buffer.from('legacy-ciphertext'),
    '2026-08-24T10:00:00.000Z', '2026-08-24T10:00:00.000Z',
  );
  legacy.close();

  const migrated = initializeDatabase(databasePath);
  const profiles = new ConnectionProfileRepository(migrated).list();

  assert.equal(migrated.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, 'Legacy TEST');
  assert.equal(profiles[0]?.host, 'legacy-host');
  const profileColumns = migrated.pragma('table_info(connection_profiles)') as Array<{ name: string }>;
  assert.equal(profileColumns.some((column) => column.name === 'encrypted_password'), false);
  assert.deepEqual(listTables(migrated), ['audit_log', 'connection_profiles', 'query_history', 'saved_queries']);
  migrated.close();
});

test('databases newer than schema v5 are rejected', () => {
  const databasePath = nextDatabasePath();
  const database = new Database(databasePath);
  database.pragma('user_version = 6');
  database.close();
  assert.throws(() => initializeDatabase(databasePath), /newer application version/);
});

test('independent userData directories isolate Profiles, Saved Queries, History, and Audit', async () => {
  const userADirectory = path.join(testDirectory, 'windows-user-a');
  const userBDirectory = path.join(testDirectory, 'windows-user-b');
  mkdirSync(userADirectory);
  mkdirSync(userBDirectory);

  const userADatabasePath = path.join(userADirectory, LOCAL_DATABASE_FILENAME);
  const userBDatabasePath = path.join(userBDirectory, LOCAL_DATABASE_FILENAME);
  assert.notEqual(userADatabasePath, userBDatabasePath);

  const userADatabase = initializeDatabase(userADatabasePath);
  new ConnectionProfileService(new ConnectionProfileRepository(userADatabase)).createProfile({
    name: 'User A profile',
    host: 'user-a-host',
    port: 5432,
    database: 'user_a_database',
    username: 'user_a',
    environment: 'TEST',
  });
  new SavedQueryService(new SavedQueryRepository(userADatabase)).createQuery({
    name: 'User A query',
    sqlText: 'SELECT 1;',
  });
  await new LocalQueryActivityService(
    new QueryHistoryRepository(userADatabase),
    new AuditLogRepository(userADatabase),
    identity,
  ).recordAttempt(attempt('SUCCESS'));
  userADatabase.close();

  const userBDatabase = initializeDatabase(userBDatabasePath);
  assert.deepEqual(new ConnectionProfileRepository(userBDatabase).list(), []);
  assert.deepEqual(new SavedQueryRepository(userBDatabase).list(), []);
  assert.deepEqual(new QueryHistoryRepository(userBDatabase).list(), []);
  assert.deepEqual(new AuditLogRepository(userBDatabase).list(), []);

  new ConnectionProfileService(new ConnectionProfileRepository(userBDatabase)).createProfile({
    name: 'User B profile',
    host: 'user-b-host',
    port: 5432,
    database: 'user_b_database',
    username: 'user_b',
    environment: 'DEV',
  });
  new SavedQueryService(new SavedQueryRepository(userBDatabase)).createQuery({
    name: 'User B query',
    sqlText: 'SELECT 2;',
  });
  await new LocalQueryActivityService(
    new QueryHistoryRepository(userBDatabase),
    new AuditLogRepository(userBDatabase),
    identity,
  ).recordAttempt({
    ...attempt('BLOCKED'),
    sqlText: 'DELETE FROM blocked;',
  });
  userBDatabase.close();

  const reopenedUserA = initializeDatabase(userADatabasePath);
  assert.deepEqual(
    new ConnectionProfileRepository(reopenedUserA).list().map((profile) => profile.name),
    ['User A profile'],
  );
  assert.deepEqual(
    new SavedQueryRepository(reopenedUserA).list().map((query) => query.name),
    ['User A query'],
  );
  assert.deepEqual(
    new QueryHistoryRepository(reopenedUserA).list().map((entry) => entry.sqlText),
    ['SELECT 1;'],
  );
  assert.deepEqual(
    new AuditLogRepository(reopenedUserA).list().map((entry) => entry.sqlText),
    ['SELECT 1;'],
  );
  reopenedUserA.close();

  const reopenedUserB = initializeDatabase(userBDatabasePath);
  assert.deepEqual(
    new ConnectionProfileRepository(reopenedUserB).list().map((profile) => profile.name),
    ['User B profile'],
  );
  assert.deepEqual(
    new SavedQueryRepository(reopenedUserB).list().map((query) => query.name),
    ['User B query'],
  );
  assert.deepEqual(
    new QueryHistoryRepository(reopenedUserB).list().map((entry) => entry.sqlText),
    ['DELETE FROM blocked;'],
  );
  assert.deepEqual(
    new AuditLogRepository(reopenedUserB).list().map((entry) => entry.sqlText),
    ['DELETE FROM blocked;'],
  );
  reopenedUserB.close();
});

test('migration 2 through 5 preserves existing Audit rows and enables mutation outcomes', () => {
  const databasePath = nextDatabasePath();
  const database = initializeDatabase(databasePath);
  const repository = new AuditLogRepository(database);
  repository.add(auditEntry(1));
  database.pragma('user_version = 2');
  database.close();

  const migrated = initializeDatabase(databasePath);
  const migratedRepository = new AuditLogRepository(migrated);
  const existing = migratedRepository.list();
  assert.equal(existing.length, 1);
  assert.equal(existing[0]?.operation, 'EXECUTE');
  migratedRepository.add({
    ...auditEntry(2),
    operation: 'UPDATE',
    outcome: 'PENDING',
  });
  assert.equal(migratedRepository.list()[0]?.outcome, 'PENDING');
  migrated.close();
});

test('migration 3 to 5 preserves activity and enables CANCELLED in History and Audit', async () => {
  const databasePath = nextDatabasePath();
  const database = initializeDatabase(databasePath);
  await new LocalQueryActivityService(
    new QueryHistoryRepository(database),
    new AuditLogRepository(database),
    identity,
  ).recordAttempt(attempt('SUCCESS'));
  database.pragma('user_version = 3');
  database.close();

  const migrated = initializeDatabase(databasePath);
  const history = new QueryHistoryRepository(migrated);
  const audit = new AuditLogRepository(migrated);
  await new LocalQueryActivityService(history, audit, identity).recordAttempt({
    ...attempt('CANCELLED'),
    errorCode: '57014',
    errorMessage: 'Query cancelled',
  });

  assert.deepEqual(history.list().map((entry) => entry.status).sort(), ['CANCELLED', 'SUCCESS']);
  assert.deepEqual(audit.list().map((entry) => entry.outcome).sort(), ['CANCELLED', 'SUCCESS']);
  migrated.close();
});

test('Saved Query CRUD persists name, description, and SQL', () => {
  const database = initializeDatabase(nextDatabasePath());
  const service = new SavedQueryService(new SavedQueryRepository(database));
  const created = service.createQuery({
    name: 'Open tickets',
    description: 'Support queue',
    sqlText: 'SELECT id FROM support.tickets;',
  });

  assert.equal(service.listQueries()[0]?.id, created.id);
  const updated = service.updateQuery({
    id: created.id,
    name: 'Open tickets today',
    description: 'Renamed description',
    sqlText: created.sqlText,
  });
  assert.equal(updated.name, 'Open tickets today');
  assert.equal(updated.description, 'Renamed description');

  service.deleteQuery(created.id);
  assert.deepEqual(service.listQueries(), []);
  database.close();
});

test('Saved Queries reject an empty name and empty SQL', () => {
  const database = initializeDatabase(nextDatabasePath());
  const service = new SavedQueryService(new SavedQueryRepository(database));
  assert.throws(
    () => service.createQuery({ name: ' ', sqlText: 'SELECT 1;' }),
    SavedQueryServiceError,
  );
  assert.throws(
    () => service.createQuery({ name: 'Valid name', sqlText: '\n  ' }),
    SavedQueryServiceError,
  );
  assert.equal(service.listQueries().length, 0);
  database.close();
});

test('Saved/History Load replaces editor text but never invokes Execute', () => {
  let editorSql = 'SELECT existing;';
  const executeCalls = 0;
  const savedRequest = prepareEditorLoad('SELECT saved;', editorSql, 'saved query');
  assert.equal(savedRequest.requiresConfirmation, true);

  commitEditorLoad(savedRequest, (sql) => { editorSql = sql; });

  assert.equal(editorSql, 'SELECT saved;');
  assert.equal(executeCalls, 0);
  const historyRequest = prepareEditorLoad('SELECT history;', '', 'history query');
  commitEditorLoad(historyRequest, (sql) => { editorSql = sql; });
  assert.equal(editorSql, 'SELECT history;');
  assert.equal(executeCalls, 0);
  void executeCalls;
});

test('SUCCESS, ERROR, TIMEOUT, BLOCKED, and CANCELLED are written to History and Audit', async () => {
  const database = initializeDatabase(nextDatabasePath());
  const history = new QueryHistoryRepository(database);
  const audit = new AuditLogRepository(database);
  const service = new LocalQueryActivityService(history, audit, identity);

  for (const status of ['SUCCESS', 'ERROR', 'TIMEOUT', 'BLOCKED', 'CANCELLED'] as const) {
    await service.recordAttempt({
      ...attempt(status),
      errorCode: status === 'TIMEOUT' ? '57014' : null,
      errorMessage: status === 'SUCCESS' ? null : `Safe ${status} message`,
    });
  }

  assert.deepEqual(history.list().map((entry) => entry.status).sort(), ['BLOCKED', 'CANCELLED', 'ERROR', 'SUCCESS', 'TIMEOUT']);
  assert.deepEqual(audit.list().map((entry) => entry.outcome).sort(), ['BLOCKED', 'CANCELLED', 'ERROR', 'SUCCESS', 'TIMEOUT']);
  assert.equal(audit.list().every((entry) => entry.operation === 'EXECUTE'), true);
  database.close();
});

test('History FIFO keeps 500 entries while Audit is never trimmed with it', () => {
  const database = initializeDatabase(nextDatabasePath());
  const history = new QueryHistoryRepository(database);
  const audit = new AuditLogRepository(database);

  for (let index = 0; index <= QUERY_HISTORY_LIMIT; index += 1) {
    history.add(historyEntry(index));
    audit.add(auditEntry(index));
  }

  assert.equal(history.list().length, QUERY_HISTORY_LIMIT);
  assert.equal(history.list().some((entry) => entry.id === uuidFor(0)), false);
  const auditCount = database.prepare<[], { count: number }>('SELECT count(*) AS count FROM audit_log').get();
  assert.equal(auditCount?.count, QUERY_HISTORY_LIMIT + 1);
  database.close();
});

test('Saved Queries, History, and Audit survive a database restart', async () => {
  const databasePath = nextDatabasePath();
  const database = initializeDatabase(databasePath);
  new SavedQueryService(new SavedQueryRepository(database)).createQuery({
    name: 'Persistent query',
    sqlText: 'SELECT 42;',
  });
  await new LocalQueryActivityService(
    new QueryHistoryRepository(database),
    new AuditLogRepository(database),
    identity,
  ).recordAttempt(attempt('SUCCESS'));
  database.close();

  const reopened = initializeDatabase(databasePath);
  assert.equal(new SavedQueryRepository(reopened).list().length, 1);
  assert.equal(new QueryHistoryRepository(reopened).list().length, 1);
  assert.equal(new AuditLogRepository(reopened).list().length, 1);
  reopened.close();
});

test('History/Audit DTOs and IPC contain no credentials or Audit mutation channel', async () => {
  const database = initializeDatabase(nextDatabasePath());
  const service = new LocalQueryActivityService(
    new QueryHistoryRepository(database),
    new AuditLogRepository(database),
    identity,
  );
  await service.recordAttempt(attempt('SUCCESS'));
  const serialized = JSON.stringify({ history: service.listHistory(), audit: service.listAuditLog() });
  const channelNames = Object.keys(LOCAL_QUERY_DATA_CHANNELS);
  const preloadSource = readFileSync(path.join(process.cwd(), 'electron', 'preload.ts'), 'utf8');

  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('encryptedPassword'), false);
  assert.equal(serialized.includes('connectionString'), false);
  assert.deepEqual(channelNames.filter((name) => name.toLowerCase().includes('audit')), ['listAuditLog']);
  assert.doesNotMatch(preloadSource, /(write|create|update|delete)Audit/i);
  database.close();
});

test('History CSV export is UTF-8 Excel-friendly and escapes SQL and Russian text', () => {
  const entry: QueryHistoryEntry = {
    ...historyEntry(1),
    sqlText: 'SELECT "Имя", note\nFROM support.tickets WHERE note = \'Привет, мир\';',
    errorMessage: 'Ошибка: значение "не найдено", повторите',
  };

  const csv = serializeHistoryExport([entry], 'CSV');

  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.equal(csv.endsWith('\r\n'), true);
  assert.match(csv, /"SELECT ""Имя"", note\nFROM support\.tickets WHERE note = 'Привет, мир';"/);
  assert.match(csv, /"Ошибка: значение ""не найдено"", повторите"/);
});

test('Audit JSON export contains readable real records without UI markup', () => {
  const entry: AuditLogEntry = {
    ...auditEntry(2),
    sqlText: 'SELECT * FROM журнал;',
    errorMessage: 'Проверка завершена',
  };

  const json = serializeAuditExport([entry], 'JSON');
  const parsed = JSON.parse(json) as AuditLogEntry[];

  assert.deepEqual(parsed, [entry]);
  assert.match(json, /\n {2}\{/);
  assert.equal(json.endsWith('\n'), true);
  assert.doesNotMatch(json, /className|<table|<span/i);
});

test('activity exports use an allowlist and never include credentials', () => {
  const secretHistory = Object.assign(historyEntry(3), {
    password: 'history-password-secret',
    encryptedPassword: 'history-encrypted-secret',
    connectionString: 'postgres://history-connection-secret',
  });
  const secretAudit = Object.assign(auditEntry(4), {
    password: 'audit-password-secret',
    temporaryPassword: 'audit-temporary-secret',
    connectionString: 'postgres://audit-connection-secret',
  });

  const exports = [
    serializeHistoryExport([secretHistory], 'CSV'),
    serializeHistoryExport([secretHistory], 'JSON'),
    serializeAuditExport([secretAudit], 'CSV'),
    serializeAuditExport([secretAudit], 'JSON'),
  ];

  for (const content of exports) {
    assert.doesNotMatch(content, /password|encryptedPassword|temporaryPassword|connectionString/i);
    assert.doesNotMatch(content, /history-password-secret|history-encrypted-secret|history-connection-secret/);
    assert.doesNotMatch(content, /audit-password-secret|audit-temporary-secret|audit-connection-secret/);
  }
});

test('activity export IPC accepts only source and format while filesystem access remains in main', () => {
  assert.deepEqual(
    parseQueryActivityExportRequest({ source: 'HISTORY', format: 'CSV' }),
    { source: 'HISTORY', format: 'CSV' },
  );
  assert.deepEqual(
    parseQueryActivityExportRequest({ source: 'AUDIT', format: 'JSON' }),
    { source: 'AUDIT', format: 'JSON' },
  );
  assert.throws(
    () => parseQueryActivityExportRequest({ source: 'HISTORY', format: 'CSV', filePath: 'arbitrary.csv' }),
    /Invalid query activity export request/,
  );
  assert.throws(() => parseQueryActivityExportRequest({ source: 'PROFILES', format: 'CSV' }));
  assert.throws(() => parseQueryActivityExportRequest({ source: 'AUDIT', format: 'XML' }));

  const preloadSource = readFileSync(path.join(process.cwd(), 'electron', 'preload.ts'), 'utf8');
  const mainHandlerSource = readFileSync(
    path.join(process.cwd(), 'electron', 'ipc', 'localQueryDataHandlers.ts'),
    'utf8',
  );
  assert.match(preloadSource, /exportQueryActivity:\s*\(request/);
  assert.doesNotMatch(preloadSource, /node:fs|showSaveDialog|writeFile/);
  assert.match(mainHandlerSource, /dialog\.showSaveDialog/);
  assert.match(mainHandlerSource, /writeFile\(selection\.filePath/);
  assert.equal(LOCAL_QUERY_DATA_CHANNELS.exportQueryActivity, 'local-query-data:activity:export');
});

test('Audit storage failure is visible, secret-free, and does not prevent History', async () => {
  const history = new MemoryHistoryStore();
  const audit = new FailingAuditStore();
  const reports: string[] = [];
  const service = new LocalQueryActivityService(history, audit, identity, (message) => reports.push(message));

  const result = await service.recordAttempt(attempt('SUCCESS'));

  assert.equal(history.entries.length, 1);
  assert.deepEqual(result.warnings, ['Не удалось записать журнал аудита.']);
  assert.deepEqual(reports, ['[SUPRA] Не удалось записать журнал аудита.']);
  assert.equal(JSON.stringify({ result, reports }).includes('SELECT 1'), false);
});

function nextDatabasePath(): string {
  databaseSequence += 1;
  return path.join(testDirectory, `query-data-${databaseSequence}.db`);
}

function createVersionOneSchema(database: Database.Database): void {
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

function listTables(database: Database.Database): string[] {
  return database.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function attempt(status: QueryHistoryEntry['status']) {
  return {
    sqlText: 'SELECT 1;',
    connection: {
      profileId: 'a2f7b608-23cd-4ad5-987b-c15a2cb84c78',
      name: 'SUPRA TEST',
      host: 'test-host',
      port: 5432,
      database: 'supra_test',
      username: 'support_user',
      environment: 'TEST' as const,
    },
    status,
    durationMs: 12,
    returnedRows: status === 'SUCCESS' ? 1 : null,
    truncated: false,
    errorCode: null,
    errorMessage: null,
  };
}

function historyEntry(index: number): QueryHistoryEntry {
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

function auditEntry(index: number): AuditLogEntry {
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

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

class MemoryHistoryStore implements QueryHistoryStore {
  readonly entries: QueryHistoryEntry[] = [];
  add(entry: QueryHistoryEntry): void { this.entries.push(entry); }
  list(): QueryHistoryEntry[] { return this.entries; }
}

class FailingAuditStore implements AuditLogStore {
  add(): void { throw new Error('raw SELECT 1 storage failure'); }
  list(): AuditLogEntry[] { return []; }
}
