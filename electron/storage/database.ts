import Database from 'better-sqlite3';

export const LOCAL_DATABASE_FILENAME = 'supra-console.db';
export const CURRENT_SCHEMA_VERSION = 4;

export function initializeDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);

  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');

  const currentVersion = database.pragma('user_version', { simple: true });
  if (typeof currentVersion !== 'number' || !Number.isInteger(currentVersion)) {
    database.close();
    throw new Error('Invalid local database schema version.');
  }
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    database.close();
    throw new Error('The local database was created by a newer application version.');
  }

  if (currentVersion === 0) {
    const migrateToVersionOne = database.transaction(() => {
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
    });

    migrateToVersionOne();
  }

  if (database.pragma('user_version', { simple: true }) === 1) {
    const migrateToVersionTwo = database.transaction(() => {
      database.exec(`
        CREATE TABLE saved_queries (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          description TEXT,
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE query_history (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          timestamp TEXT NOT NULL,
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          profile_name TEXT,
          environment TEXT CHECK (environment IS NULL OR environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
          host TEXT,
          database_name TEXT,
          database_user TEXT,
          status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED', 'TIMEOUT')),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          returned_rows INTEGER CHECK (returned_rows IS NULL OR returned_rows >= 0),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          error_message TEXT
        ) STRICT;

        CREATE INDEX query_history_timestamp_idx
          ON query_history(timestamp DESC);

        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          timestamp TEXT NOT NULL,
          windows_user TEXT NOT NULL CHECK (length(trim(windows_user)) > 0),
          computer_name TEXT NOT NULL CHECK (length(trim(computer_name)) > 0),
          profile_name TEXT,
          environment TEXT CHECK (environment IS NULL OR environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
          host TEXT,
          database_name TEXT,
          database_user TEXT,
          operation TEXT NOT NULL CHECK (operation = 'EXECUTE'),
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'ERROR', 'BLOCKED', 'TIMEOUT')),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          returned_rows INTEGER CHECK (returned_rows IS NULL OR returned_rows >= 0),
          error_code TEXT,
          error_message TEXT
        ) STRICT;

        CREATE INDEX audit_log_timestamp_idx
          ON audit_log(timestamp DESC);
      `);
      database.pragma('user_version = 2');
    });

    migrateToVersionTwo();
  }

  if (database.pragma('user_version', { simple: true }) === 2) {
    const migrateToVersionThree = database.transaction(() => {
      database.exec(`
        DROP INDEX audit_log_timestamp_idx;
        ALTER TABLE audit_log RENAME TO audit_log_v2;

        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          timestamp TEXT NOT NULL,
          windows_user TEXT NOT NULL CHECK (length(trim(windows_user)) > 0),
          computer_name TEXT NOT NULL CHECK (length(trim(computer_name)) > 0),
          profile_name TEXT,
          environment TEXT CHECK (environment IS NULL OR environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
          host TEXT,
          database_name TEXT,
          database_user TEXT,
          operation TEXT NOT NULL CHECK (operation IN ('EXECUTE', 'MUTATION', 'INSERT', 'UPDATE', 'COMMIT', 'ROLLBACK')),
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          outcome TEXT NOT NULL CHECK (outcome IN (
            'SUCCESS', 'ERROR', 'BLOCKED', 'TIMEOUT', 'VALIDATED', 'PENDING',
            'COMMITTED', 'ROLLED_BACK', 'AUTO_ROLLED_BACK', 'CONNECTION_LOST'
          )),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          returned_rows INTEGER CHECK (returned_rows IS NULL OR returned_rows >= 0),
          error_code TEXT,
          error_message TEXT
        ) STRICT;

        INSERT INTO audit_log (
          id, timestamp, windows_user, computer_name, profile_name,
          environment, host, database_name, database_user, operation,
          sql_text, outcome, duration_ms, returned_rows, error_code, error_message
        )
        SELECT
          id, timestamp, windows_user, computer_name, profile_name,
          environment, host, database_name, database_user, operation,
          sql_text, outcome, duration_ms, returned_rows, error_code, error_message
        FROM audit_log_v2;

        DROP TABLE audit_log_v2;
        CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC);
      `);
      database.pragma('user_version = 3');
    });

    migrateToVersionThree();
  }

  if (database.pragma('user_version', { simple: true }) === 3) {
    const migrateToVersionFour = database.transaction(() => {
      database.exec(`
        DROP INDEX query_history_timestamp_idx;
        ALTER TABLE query_history RENAME TO query_history_v3;

        CREATE TABLE query_history (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          timestamp TEXT NOT NULL,
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          profile_name TEXT,
          environment TEXT CHECK (environment IS NULL OR environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
          host TEXT,
          database_name TEXT,
          database_user TEXT,
          status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED', 'TIMEOUT', 'CANCELLED')),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          returned_rows INTEGER CHECK (returned_rows IS NULL OR returned_rows >= 0),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          error_message TEXT
        ) STRICT;

        INSERT INTO query_history (
          id, timestamp, sql_text, profile_name, environment, host,
          database_name, database_user, status, duration_ms,
          returned_rows, truncated, error_message
        )
        SELECT
          id, timestamp, sql_text, profile_name, environment, host,
          database_name, database_user, status, duration_ms,
          returned_rows, truncated, error_message
        FROM query_history_v3;

        DROP TABLE query_history_v3;
        CREATE INDEX query_history_timestamp_idx ON query_history(timestamp DESC);

        DROP INDEX audit_log_timestamp_idx;
        ALTER TABLE audit_log RENAME TO audit_log_v3;

        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          timestamp TEXT NOT NULL,
          windows_user TEXT NOT NULL CHECK (length(trim(windows_user)) > 0),
          computer_name TEXT NOT NULL CHECK (length(trim(computer_name)) > 0),
          profile_name TEXT,
          environment TEXT CHECK (environment IS NULL OR environment IN ('PROD', 'TEST', 'DEV', 'OTHER')),
          host TEXT,
          database_name TEXT,
          database_user TEXT,
          operation TEXT NOT NULL CHECK (operation IN ('EXECUTE', 'MUTATION', 'INSERT', 'UPDATE', 'COMMIT', 'ROLLBACK')),
          sql_text TEXT NOT NULL CHECK (length(trim(sql_text)) > 0),
          outcome TEXT NOT NULL CHECK (outcome IN (
            'SUCCESS', 'ERROR', 'BLOCKED', 'TIMEOUT', 'CANCELLED', 'VALIDATED', 'PENDING',
            'COMMITTED', 'ROLLED_BACK', 'AUTO_ROLLED_BACK', 'CONNECTION_LOST'
          )),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          returned_rows INTEGER CHECK (returned_rows IS NULL OR returned_rows >= 0),
          error_code TEXT,
          error_message TEXT
        ) STRICT;

        INSERT INTO audit_log (
          id, timestamp, windows_user, computer_name, profile_name,
          environment, host, database_name, database_user, operation,
          sql_text, outcome, duration_ms, returned_rows, error_code, error_message
        )
        SELECT
          id, timestamp, windows_user, computer_name, profile_name,
          environment, host, database_name, database_user, operation,
          sql_text, outcome, duration_ms, returned_rows, error_code, error_message
        FROM audit_log_v3;

        DROP TABLE audit_log_v3;
        CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp DESC);
      `);
      database.pragma('user_version = 4');
    });

    migrateToVersionFour();
  }

  return database;
}
