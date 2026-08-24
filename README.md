# SUPRA Query Console

Windows desktop PostgreSQL support console. Connection profiles are stored locally in SQLite, with optional password encryption through Electron `safeStorage`. PostgreSQL Test/Connect/Disconnect, lazy metadata browsing, and validated SELECT execution use one serialized main-process `pg.Client`. The renderer-side Visual Query Builder creates quoted SELECT drafts from loaded metadata.

User SQL is parsed with `pgsql-parser` before every execution. SELECT keeps its Stage 6 path: only one AST-validated SELECT is accepted, it runs inside a `READ ONLY` transaction with a transaction-local 15 second timeout, a server-side 1001-row fetch cap, and an unconditional `ROLLBACK`; at most 1000 normalized rows reach the renderer.

Stage 8 adds a separate mutation path for one schema-qualified INSERT or UPDATE. UPDATE requires WHERE. RETURNING, data-modifying CTEs, ON CONFLICT DO UPDATE, system-schema targets, DELETE, MERGE, TRUNCATE, DDL, utility statements, manual transaction SQL, and multiple statements are rejected by the main-process AST safety service. A validated change requires an explicit UI confirmation, then executes as `BEGIN`, local 15-second statement timeout, local 5-second lock timeout, and the mutation statement. It is never committed automatically: the transaction remains exclusive until COMMIT, ROLLBACK, connection cleanup, or automatic rollback after 120 seconds.

While a mutation transaction is pending, a shared main-process operation gate blocks SELECT, metadata, Test Connection, Connect, and a second mutation. Renderer IPC accepts only a one-time preparation ID for execution and the exact current transaction ID for COMMIT/ROLLBACK; it cannot submit arbitrary transaction-control SQL. Disconnect and application shutdown attempt ROLLBACK before closing the PostgreSQL client, while unexpected connection loss clears local transaction state.

The application database is named `supra-console.db` and is resolved at runtime under Electron's `app.getPath('userData')`. It is never stored next to the portable executable.

SQLite schema version 3 also stores local Saved Queries, the latest 500 user Execute attempts, and an untrimmed local Audit Log. Query execution records SUCCESS, PostgreSQL ERROR, TIMEOUT, and safety BLOCKED outcomes in the main process. Mutation audit additionally records validation, pending INSERT/UPDATE, COMMIT, manual/automatic ROLLBACK, errors, and connection loss. The renderer can manage Saved Queries and read History/Audit, but it has no Audit create, update, or delete IPC. Loading Saved/History SQL only replaces editor text after the existing Cancel/Replace safeguard and never executes it.

Audit records the Windows username and computer name, database target, environment, database user, SQL, safe outcome/error information, duration, and row count. It never stores passwords, encrypted passwords, connection strings, or stack traces. This local SQLite audit is operational trace data, not tamper-proof security logging; a Windows user with filesystem access can modify or delete it. `QueryActivityRecorder` is the boundary for adding a centralized audit backend in a later stage.

## Commands

```powershell
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run build:portable
```

The portable x64 Windows executable is emitted into `release/`.
