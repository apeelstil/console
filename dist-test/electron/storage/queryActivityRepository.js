"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogRepository = exports.QueryHistoryRepository = exports.AUDIT_UI_LIMIT = exports.QUERY_HISTORY_LIMIT = void 0;
exports.QUERY_HISTORY_LIMIT = 500;
exports.AUDIT_UI_LIMIT = 500;
class QueryHistoryRepository {
    database;
    insertAndTrim;
    constructor(database) {
        this.database = database;
        this.insertAndTrim = database.transaction((entry) => {
            database.prepare(`
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
          LIMIT -1 OFFSET ${exports.QUERY_HISTORY_LIMIT}
        )
      `).run();
        });
    }
    add(entry) {
        this.insertAndTrim(entry);
    }
    list() {
        return this.database.prepare(`
      SELECT id, timestamp, sql_text, profile_name, environment, host,
             database_name, database_user, status, duration_ms,
             returned_rows, truncated, error_message
      FROM query_history
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ${exports.QUERY_HISTORY_LIMIT}
    `).all().map(mapHistoryRow);
    }
}
exports.QueryHistoryRepository = QueryHistoryRepository;
class AuditLogRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    add(entry) {
        this.database.prepare(`
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
    list() {
        return this.database.prepare(`
      SELECT id, timestamp, windows_user, computer_name, profile_name,
             environment, host, database_name, database_user, operation,
             sql_text, outcome, duration_ms, returned_rows, error_code, error_message
      FROM audit_log
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ${exports.AUDIT_UI_LIMIT}
    `).all().map(mapAuditRow);
    }
}
exports.AuditLogRepository = AuditLogRepository;
function toHistoryParameters(entry) {
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
function toAuditParameters(entry) {
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
function mapHistoryRow(row) {
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
function mapAuditRow(row) {
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
