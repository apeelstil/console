"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresQueryExecutionService = exports.QueryExecutionError = void 0;
exports.normalizeValue = normalizeValue;
exports.getSafeQueryError = getSafeQueryError;
const postgresOperationGate_1 = require("./postgresOperationGate");
const postgresConnectionManager_1 = require("./postgresConnectionManager");
const sqlSafetyService_1 = require("./sqlSafetyService");
const BEGIN_READ_ONLY_SQL = 'BEGIN READ ONLY;';
const SET_LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout = '15000ms';";
const ROLLBACK_SQL = 'ROLLBACK;';
const MAX_RESULT_ROWS = 1_000;
class QueryExecutionError extends Error {
    details;
    constructor(details) {
        super(details.message);
        this.details = details;
        this.name = 'QueryExecutionError';
    }
}
exports.QueryExecutionError = QueryExecutionError;
class PostgresQueryExecutionService {
    connectionManager;
    safetyService;
    activityRecorder;
    executionInProgress = false;
    constructor(connectionManager, safetyService, activityRecorder) {
        this.connectionManager = connectionManager;
        this.safetyService = safetyService;
        this.activityRecorder = activityRecorder;
    }
    async executeSelect(sql) {
        if (this.executionInProgress) {
            const details = {
                kind: 'EXECUTION',
                message: 'A query is already executing.',
            };
            const storageWarnings = await this.recordAttempt({
                sqlText: sql,
                connection: this.connectionManager.getConnectionState().connection,
                status: 'BLOCKED',
                durationMs: 0,
                returnedRows: null,
                truncated: false,
                errorCode: null,
                errorMessage: details.message,
            });
            throw new QueryExecutionError(withStorageWarnings(details, storageWarnings));
        }
        this.executionInProgress = true;
        const startedAt = Date.now();
        const connection = this.connectionManager.getConnectionState().connection;
        try {
            const safeQuery = await this.safetyService.validateSelect(sql);
            const result = await this.connectionManager.withActiveClient(async (client) => {
                const result = await executeReadOnlyTransaction(client, safeQuery.executableSql);
                return normalizeResult(result, Date.now() - startedAt);
            });
            const storageWarnings = await this.recordAttempt({
                sqlText: sql,
                connection,
                status: 'SUCCESS',
                durationMs: result.durationMs,
                returnedRows: result.returnedRows,
                truncated: result.truncated,
                errorCode: null,
                errorMessage: null,
            });
            return withStorageWarnings(result, storageWarnings);
        }
        catch (error) {
            const details = getSafeQueryError(error);
            const storageWarnings = await this.recordAttempt({
                sqlText: sql,
                connection,
                status: details.kind === 'NOT_ALLOWED'
                    ? 'BLOCKED'
                    : details.kind === 'TIMEOUT'
                        ? 'TIMEOUT'
                        : 'ERROR',
                durationMs: Math.max(0, Date.now() - startedAt),
                returnedRows: null,
                truncated: false,
                errorCode: details.sqlState ?? null,
                errorMessage: details.message,
            });
            throw new QueryExecutionError(withStorageWarnings(details, storageWarnings));
        }
        finally {
            this.executionInProgress = false;
        }
    }
    async recordAttempt(attempt) {
        try {
            return (await this.activityRecorder.recordAttempt(attempt)).warnings;
        }
        catch {
            const warning = 'Query activity storage is unavailable.';
            console.error(`[SUPRA] ${warning}`);
            return [warning];
        }
    }
}
exports.PostgresQueryExecutionService = PostgresQueryExecutionService;
async function executeReadOnlyTransaction(client, executableSql) {
    let transactionStarted = false;
    let result;
    let operationError;
    try {
        await client.query(BEGIN_READ_ONLY_SQL);
        transactionStarted = true;
        await client.query(SET_LOCAL_TIMEOUT_SQL);
        result = await client.query({ text: executableSql, rowMode: 'array' });
    }
    catch (error) {
        operationError = error;
    }
    finally {
        if (transactionStarted) {
            try {
                await client.query(ROLLBACK_SQL);
            }
            catch (rollbackError) {
                if (operationError === undefined)
                    operationError = rollbackError;
            }
        }
    }
    if (operationError !== undefined)
        throw operationError;
    if (!result)
        throw new Error('Query returned no result.');
    return result;
}
function normalizeResult(result, durationMs) {
    const sourceRows = result.rows.slice(0, MAX_RESULT_ROWS);
    const columns = normalizeColumns(result, sourceRows);
    const rows = sourceRows.map((row) => normalizeRow(row, columns));
    return {
        columns,
        rows,
        returnedRows: rows.length,
        truncated: result.rows.length > MAX_RESULT_ROWS,
        durationMs: Math.max(0, durationMs),
    };
}
function normalizeColumns(result, rows) {
    if (result.fields && result.fields.length > 0) {
        return result.fields.map((field) => ({
            name: field.name,
            ...(Number.isSafeInteger(field.dataTypeID) ? { dataTypeId: field.dataTypeID } : {}),
        }));
    }
    const firstRow = rows[0];
    if (Array.isArray(firstRow)) {
        return firstRow.map((_value, index) => ({ name: `column_${index + 1}` }));
    }
    if (isRecord(firstRow))
        return Object.keys(firstRow).map((name) => ({ name }));
    return [];
}
function normalizeRow(row, columns) {
    if (Array.isArray(row))
        return columns.map((_column, index) => normalizeValue(row[index]));
    if (isRecord(row))
        return columns.map((column) => normalizeValue(row[column.name]));
    return columns.map(() => null);
}
function normalizeValue(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint')
        return value.toString();
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? 'Invalid date' : value.toISOString();
    }
    if (Buffer.isBuffer(value))
        return `\\x${value.toString('hex')}`;
    if (typeof value === 'object') {
        try {
            const seen = new WeakSet();
            const serialized = JSON.stringify(value, (_key, nestedValue) => {
                if (typeof nestedValue === 'bigint')
                    return nestedValue.toString();
                if (typeof nestedValue === 'object' && nestedValue !== null) {
                    if (seen.has(nestedValue))
                        return '[Circular]';
                    seen.add(nestedValue);
                }
                return nestedValue;
            });
            return serialized ?? String(value);
        }
        catch {
            return 'Unserializable value';
        }
    }
    return String(value);
}
function getSafeQueryError(error) {
    if (error instanceof QueryExecutionError)
        return error.details;
    if (error instanceof sqlSafetyService_1.SqlSafetyError)
        return error.details;
    if (error instanceof postgresConnectionManager_1.ConnectionManagerError) {
        return { kind: 'CONNECTION', message: error.safeMessage };
    }
    if (error instanceof postgresOperationGate_1.PostgresOperationBlockedError) {
        return { kind: 'EXECUTION', message: error.safeMessage };
    }
    const details = isRecord(error) ? error : {};
    const code = typeof details.code === 'string' && details.code.length === 5
        ? details.code
        : undefined;
    const position = typeof details.position === 'string'
        ? Number(details.position)
        : details.position;
    const safePosition = typeof position === 'number'
        && Number.isSafeInteger(position)
        && position >= 0
        ? position
        : undefined;
    if (code === '57014') {
        return { kind: 'TIMEOUT', message: 'The query exceeded the 15 second timeout.', sqlState: code };
    }
    if (code === '42501') {
        return { kind: 'PERMISSION_DENIED', message: 'Permission denied while executing the SELECT query.', sqlState: code };
    }
    if (code === '42601') {
        return {
            kind: 'SYNTAX',
            message: 'The PostgreSQL server rejected the query syntax.',
            sqlState: code,
            ...(safePosition !== undefined ? { position: safePosition } : {}),
        };
    }
    return {
        kind: 'EXECUTION',
        message: 'The SELECT query could not be executed.',
        ...(code ? { sqlState: code } : {}),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function withStorageWarnings(value, warnings) {
    return warnings.length > 0 ? { ...value, storageWarnings: warnings } : value;
}
