"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqlSafetyService = exports.SqlSafetyError = void 0;
const pgsql_parser_1 = require("pgsql-parser");
const MAX_SQL_LENGTH = 1_000_000;
const SERVER_ROW_FETCH_LIMIT = 1_001;
const RESULT_ALIAS = '__supra_query_result';
class SqlSafetyError extends Error {
    details;
    constructor(details) {
        super(details.message);
        this.details = details;
        this.name = 'SqlSafetyError';
    }
}
exports.SqlSafetyError = SqlSafetyError;
class SqlSafetyService {
    async initialize() {
        await (0, pgsql_parser_1.loadModule)();
    }
    async validateSelect(sql) {
        if (!sql.trim())
            throw notAllowed('Enter a SELECT query.');
        if (sql.length > MAX_SQL_LENGTH)
            throw notAllowed('The SQL query is too large.');
        let parsed;
        try {
            parsed = await (0, pgsql_parser_1.parse)(sql);
        }
        catch (error) {
            throw syntaxError(error);
        }
        const statements = parsed.stmts ?? [];
        if (statements.length !== 1) {
            throw notAllowed('Exactly one SELECT statement is required.');
        }
        const rawStatement = statements[0]?.stmt;
        if (!isRecord(rawStatement) || !isRecord(rawStatement.SelectStmt)) {
            throw notAllowed('Only a SELECT statement is allowed.');
        }
        validateAst(rawStatement);
        let normalizedSql;
        try {
            normalizedSql = removeTrailingSemicolon((await (0, pgsql_parser_1.deparse)(parsed)).trim());
        }
        catch {
            throw notAllowed('The SELECT query could not be safely prepared.');
        }
        if (!normalizedSql)
            throw notAllowed('Enter a SELECT query.');
        return {
            normalizedSql,
            executableSql: [
                'SELECT *',
                'FROM (',
                normalizedSql,
                `) AS "${RESULT_ALIAS}"`,
                `LIMIT ${SERVER_ROW_FETCH_LIMIT};`,
            ].join('\n'),
        };
    }
}
exports.SqlSafetyService = SqlSafetyService;
function validateAst(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            validateAst(item);
        return;
    }
    if (!isRecord(value))
        return;
    validateSelectNodeRestrictions(value);
    for (const [nodeType, nodeValue] of Object.entries(value)) {
        if (nodeType === 'CommonTableExpr')
            validateCommonTableExpression(nodeValue);
        if (nodeType.endsWith('Stmt') && nodeType !== 'SelectStmt') {
            throw notAllowed(`Statement type ${nodeType.slice(0, -4)} is not allowed.`);
        }
        if (nodeType === 'SelectStmt')
            validateSelectNode(nodeValue);
        validateAst(nodeValue);
    }
}
function validateCommonTableExpression(value) {
    if (!isRecord(value) || !isRecord(value.ctequery) || !isRecord(value.ctequery.SelectStmt)) {
        throw notAllowed('Data-modifying CTEs are not allowed.');
    }
}
function validateSelectNode(value) {
    if (!isRecord(value))
        throw notAllowed('Invalid SELECT syntax tree.');
    validateSelectNodeRestrictions(value);
}
function validateSelectNodeRestrictions(value) {
    if (value.intoClause !== undefined && value.intoClause !== null) {
        throw notAllowed('SELECT INTO is not allowed.');
    }
    if (Array.isArray(value.lockingClause) && value.lockingClause.length > 0) {
        throw notAllowed('SELECT locking clauses are not allowed.');
    }
    if (Array.isArray(value.valuesLists) && value.valuesLists.length > 0) {
        throw notAllowed('VALUES statements are not allowed; use SELECT.');
    }
}
function syntaxError(error) {
    const details = isRecord(error) && isRecord(error.sqlDetails) ? error.sqlDetails : {};
    const message = typeof details.message === 'string'
        ? limitMessage(details.message)
        : 'The SQL query has invalid PostgreSQL syntax.';
    const cursorPosition = typeof details.cursorPosition === 'number'
        && Number.isSafeInteger(details.cursorPosition)
        && details.cursorPosition >= 0
        ? details.cursorPosition
        : undefined;
    return new SqlSafetyError({
        kind: 'SYNTAX',
        message,
        sqlState: '42601',
        ...(cursorPosition !== undefined ? { position: cursorPosition } : {}),
    });
}
function notAllowed(message) {
    return new SqlSafetyError({ kind: 'NOT_ALLOWED', message });
}
function removeTrailingSemicolon(sql) {
    return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}
function limitMessage(message) {
    const singleLine = message.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
    return singleLine.slice(0, 240) || 'The SQL query has invalid PostgreSQL syntax.';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
