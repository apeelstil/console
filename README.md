# SUPRA Query Console

Windows desktop PostgreSQL support console. Connection profiles are stored locally in SQLite, with optional password encryption through Electron `safeStorage`. PostgreSQL Test/Connect/Disconnect, lazy metadata browsing, and validated SELECT execution use one serialized main-process `pg.Client`. The renderer-side Visual Query Builder creates quoted SELECT drafts from loaded metadata.

User SQL is parsed with `pgsql-parser` before every execution. SELECT keeps its Stage 6 path: only one AST-validated SELECT is accepted, it runs inside a `READ ONLY` transaction with a transaction-local 15 second timeout, a server-side 1001-row fetch cap, and an unconditional `ROLLBACK`; at most 1000 normalized rows reach the renderer.

Stage 9 adds main-process-owned SELECT lifecycle state and PostgreSQL protocol cancellation. A running SELECT is represented by its exact `pg.Query`; cancellation uses a separate short-lived `pg.Client` to send PostgreSQL's CancelRequest for that query's backend PID/secret key. The permanent client is not ended by Cancel. The original query must return PostgreSQL cancellation before the UI reports `CANCELLED`, and its read-only transaction still completes `ROLLBACK`. Timeout and manual cancellation remain distinct outcomes even though PostgreSQL uses SQLSTATE `57014` for both.

Stage 8 adds a separate mutation path for one schema-qualified INSERT or UPDATE. UPDATE requires WHERE. RETURNING, data-modifying CTEs, ON CONFLICT DO UPDATE, system-schema targets, DELETE, MERGE, TRUNCATE, DDL, utility statements, manual transaction SQL, and multiple statements are rejected by the main-process AST safety service. A validated change requires an explicit UI confirmation, then executes as `BEGIN`, local 15-second statement timeout, local 5-second lock timeout, and the mutation statement. It is never committed automatically: the transaction remains exclusive until COMMIT, ROLLBACK, connection cleanup, or automatic rollback after 120 seconds.

While a mutation transaction is pending, a shared main-process operation gate blocks SELECT, metadata, Test Connection, Connect, and a second mutation. The same gate reserves an active SELECT before validation, blocking mutation and other PostgreSQL interleaving until SELECT cleanup finishes. Renderer IPC accepts only current main-process operation IDs, a one-time mutation preparation ID, and the exact current transaction ID for COMMIT/ROLLBACK; it cannot submit arbitrary transaction-control SQL. Disconnect during SELECT first requests cancellation and waits for query cleanup/ROLLBACK, then closes the permanent client. Disconnect and application shutdown also attempt pending-mutation ROLLBACK before close, while unexpected connection loss clears local transaction state.

The application database is named `supra-console.db` and is resolved at runtime under Electron's `app.getPath('userData')`. It is never stored next to the portable executable.

SQLite schema version 4 also stores local Saved Queries, the latest 500 user Execute attempts, and an untrimmed local Audit Log. Query execution records SUCCESS, PostgreSQL ERROR, TIMEOUT, safety BLOCKED, and manual CANCELLED outcomes in the main process. Mutation audit additionally records validation, pending INSERT/UPDATE, COMMIT, manual/automatic ROLLBACK, errors, and connection loss. The renderer can manage Saved Queries and read History/Audit, but it has no Audit create, update, or delete IPC. Loading Saved/History SQL only replaces editor text after the existing Cancel/Replace safeguard and never executes it.

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

## Manual PostgreSQL Smoke Test

Use only disposable TEST/DEV data and a test account with the minimum required database permissions. Do not put credentials in the repository, screenshots, issue text, or test logs.

**Не выполнять mutation smoke-tests на PROD.**

- [ ] 1. Test Connection: verify success and a safe failure message with deliberately invalid temporary credentials.
- [ ] 2. Connect: verify the status becomes Connected and no password appears in the UI, History, Audit, or logs.
- [ ] 3. Expand Database Explorer and verify Schemas, Tables/Views, and Columns load lazily.
- [ ] 4. Select a table/view in Query Builder, choose fields/conditions, generate SQL, and verify it is a SELECT draft only.
- [ ] 5. Run an ordinary SELECT and verify Results, duration, row count, History SUCCESS, and Audit SUCCESS.
- [ ] 6. Run a SELECT returning more than 1000 rows and verify exactly 1000 rows are shown with the truncated indicator.
- [ ] 7. Run a SELECT with a PostgreSQL syntax error and verify a safe syntax message plus History/Audit ERROR.
- [ ] 8. Run `SELECT pg_sleep(20);` on TEST/DEV and verify `Query timed out`, TIMEOUT, SQLSTATE `57014`, and ROLLBACK.
- [ ] 9. Run a long TEST/DEV SELECT, press Cancel query, verify Executing... → Cancelling... → Query cancelled, CANCELLED in History/Audit, then run `SELECT 1;` successfully on the same connection.
- [ ] 10. Enter a DELETE and verify main-process safety blocks it without sending it to PostgreSQL.
- [ ] 11. Enter an UPDATE without WHERE and verify main-process safety blocks it without starting a transaction.
- [ ] 12. On disposable TEST/DEV data, run INSERT → pending and choose ROLLBACK; verify no persisted change.
- [ ] 13. On disposable TEST/DEV data, run UPDATE with WHERE → pending and choose ROLLBACK; verify no persisted change.
- [ ] 14. On a disposable TEST database only, run UPDATE with WHERE → pending → COMMIT and verify the intended row only; restore test data afterward.
- [ ] 15. On disposable TEST/DEV data, leave a pending mutation untouched for 120 seconds and verify automatic ROLLBACK.
- [ ] 16. During a long TEST/DEV SELECT press Disconnect; verify cancellation/ROLLBACK completes, status becomes Disconnected, then reconnect and run `SELECT 1;`.
- [ ] 17. Create a Saved Query and generate History/Audit, restart the application, then verify all three local sections persist.
