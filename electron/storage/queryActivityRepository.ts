import type Database from 'better-sqlite3';
import type {
  AuditLogEntry,
  QueryHistoryEntry,
} from '../../shared/localQueryData';
import type { ConnectionEnvironment } from '../../shared/connectionProfiles';

export const QUERY_HISTORY_LIMIT = 500;
export const AUDIT_UI_LIMIT = 500;

interface QueryHistoryRow {
  id: string;
  timestamp: string;
  sql_text: string;
  profile_name: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  database_name: string | null;
  database_user: string | null;
  status: QueryHistoryEntry['status'];
  duration_ms: number | null;
  returned_rows: number | null;
  truncated: 0 | 1;
  error_message: string | null;
}

interface QueryHistoryParameters {
  id: string;
  timestamp: string;
  sqlText: string;
  profileName: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  databaseName: string | null;
  databaseUser: string | null;
  status: QueryHistoryEntry['status'];
  durationMs: number | null;
  returnedRows: number | null;
  truncated: number;
  errorMessage: string | null;
}

interface AuditLogRow {
  id: string;
  timestamp: string;
  windows_user: string;
  computer_name: string;
  profile_name: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  database_name: string | null;
  database_user: string | null;
  operation: AuditLogEntry['operation'];
  sql_text: string;
  outcome: AuditLogEntry['outcome'];
  duration_ms: number | null;
  returned_rows: number | null;
  error_code: string | null;
  error_message: string | null;
}

interface AuditLogParameters {
  id: string;
  timestamp: string;
  windowsUser: string;
  computerName: string;
  profileName: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  databaseName: string | null;
  databaseUser: string | null;
  operation: AuditLogEntry['operation'];
  sqlText: string;
  outcome: AuditLogEntry['outcome'];
  durationMs: number | null;
  returnedRows: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export class QueryHistoryRepository {
  private readonly insertAndTrim: (entry: QueryHistoryEntry) => void;

  constructor(private readonly database: Database.Database) {
    this.insertAndTrim = database.transaction((entry: QueryHistoryEntry) => {
      database.prepare<QueryHistoryParameters>(`
        INSERT INTO query_history (
          id, timestamp, sql_text, profile_name, environment, host,
          database_name, database_user, status, duration_ms,
          returned_rows, truncated, error_message
        ) VALUES (
          @id, @timestamp, @sqlText, @profileName, @environment, @host,
          @databaseName, @databaseUser, @status, @durationMs,
          @returnedRows, @truncated, @errorMessage
        )
      `).run(toHistoryParameters(entry));
      database.prepare(`
        DELETE FROM query_history
        WHERE id IN (
          SELECT id FROM query_history
          ORDER BY timestamp DESC, rowid DESC
          LIMIT -1 OFFSET ${QUERY_HISTORY_LIMIT}
        )
      `).run();
    });
  }

  add(entry: QueryHistoryEntry): void {
    this.insertAndTrim(entry);
  }

  list(): QueryHistoryEntry[] {
    return this.database.prepare<[], QueryHistoryRow>(`
      SELECT id, timestamp, sql_text, profile_name, environment, host,
             database_name, database_user, status, duration_ms,
             returned_rows, truncated, error_message
      FROM query_history
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ${QUERY_HISTORY_LIMIT}
    `).all().map(mapHistoryRow);
  }
}

export class AuditLogRepository {
  constructor(private readonly database: Database.Database) {}

  add(entry: AuditLogEntry): void {
    this.database.prepare<AuditLogParameters>(`
      INSERT INTO audit_log (
        id, timestamp, windows_user, computer_name, profile_name,
        environment, host, database_name, database_user, operation,
        sql_text, outcome, duration_ms, returned_rows, error_code, error_message
      ) VALUES (
        @id, @timestamp, @windowsUser, @computerName, @profileName,
        @environment, @host, @databaseName, @databaseUser, @operation,
        @sqlText, @outcome, @durationMs, @returnedRows, @errorCode, @errorMessage
      )
    `).run(toAuditParameters(entry));
  }

  list(): AuditLogEntry[] {
    return this.database.prepare<[], AuditLogRow>(`
      SELECT id, timestamp, windows_user, computer_name, profile_name,
             environment, host, database_name, database_user, operation,
             sql_text, outcome, duration_ms, returned_rows, error_code, error_message
      FROM audit_log
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ${AUDIT_UI_LIMIT}
    `).all().map(mapAuditRow);
  }
}

function toHistoryParameters(entry: QueryHistoryEntry): QueryHistoryParameters {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    sqlText: entry.sqlText,
    profileName: entry.profileName,
    environment: entry.environment,
    host: entry.host,
    databaseName: entry.database,
    databaseUser: entry.databaseUser,
    status: entry.status,
    durationMs: entry.durationMs,
    returnedRows: entry.returnedRows,
    truncated: entry.truncated ? 1 : 0,
    errorMessage: entry.errorMessage,
  };
}

function toAuditParameters(entry: AuditLogEntry): AuditLogParameters {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    windowsUser: entry.windowsUser,
    computerName: entry.computerName,
    profileName: entry.profileName,
    environment: entry.environment,
    host: entry.host,
    databaseName: entry.database,
    databaseUser: entry.databaseUser,
    operation: entry.operation,
    sqlText: entry.sqlText,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    returnedRows: entry.returnedRows,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
  };
}

function mapHistoryRow(row: QueryHistoryRow): QueryHistoryEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    sqlText: row.sql_text,
    profileName: row.profile_name,
    environment: row.environment,
    host: row.host,
    database: row.database_name,
    databaseUser: row.database_user,
    status: row.status,
    durationMs: row.duration_ms,
    returnedRows: row.returned_rows,
    truncated: row.truncated === 1,
    errorMessage: row.error_message,
  };
}

function mapAuditRow(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    windowsUser: row.windows_user,
    computerName: row.computer_name,
    profileName: row.profile_name,
    environment: row.environment,
    host: row.host,
    database: row.database_name,
    databaseUser: row.database_user,
    operation: row.operation,
    sqlText: row.sql_text,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    returnedRows: row.returned_rows,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}
