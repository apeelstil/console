"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MutationSafetyService = exports.MutationSafetyError = void 0;
const pgsql_parser_1 = require("pgsql-parser");
const MAX_SQL_LENGTH = 1_000_000;
class MutationSafetyError extends Error {
    details;
    constructor(details) {
        super(details.message);
        this.details = details;
        this.name = 'MutationSafetyError';
    }
}
exports.MutationSafetyError = MutationSafetyError;
class MutationSafetyService {
    async initialize() {
        await (0, pgsql_parser_1.loadModule)();
    }
    async validateMutation(sql) {
        if (!sql.trim())
            throw blocked('Enter one INSERT or UPDATE statement.');
        if (sql.length > MAX_SQL_LENGTH)
            throw blocked('The SQL statement is too large.');
        let parsed;
        try {
            parsed = await (0, pgsql_parser_1.parse)(sql);
        }
        catch {
            throw blocked('The mutation SQL syntax could not be parsed safely.');
        }
        const statements = parsed.stmts ?? [];
        if (statements.length !== 1) {
            throw blocked('Exactly one INSERT or UPDATE statement is required.');
        }
        const root = statements[0]?.stmt;
        if (!isRecord(root))
            throw blocked('Only INSERT or UPDATE is allowed.');
        let operation;
        let statement;
        if (isRecord(root.InsertStmt)) {
            operation = 'INSERT';
            statement = root.InsertStmt;
        }
        else if (isRecord(root.UpdateStmt)) {
            operation = 'UPDATE';
            statement = root.UpdateStmt;
        }
        else {
            throw blocked('Only INSERT or UPDATE is allowed.');
        }
        const target = readTarget(statement, operation);
        if (containsModifyingCte(statement)) {
            throw blocked('Data-modifying CTEs are not allowed.', operation, target);
        }
        if (hasReturningClause(statement)) {
            throw blocked('RETURNING is not allowed for mutations at this stage.', operation, target);
        }
        if (operation === 'UPDATE' && !isRecord(statement.whereClause)) {
            throw blocked('UPDATE requires a WHERE clause.', operation, target);
        }
        if (operation === 'INSERT') {
            const conflict = statement.onConflictClause;
            if (isRecord(conflict) && conflict.action === 'ONCONFLICT_UPDATE') {
                throw blocked('ON CONFLICT DO UPDATE is not allowed.', operation, target);
            }
        }
        let normalizedSql;
        try {
            normalizedSql = removeTrailingSemicolon((await (0, pgsql_parser_1.deparse)(parsed)).trim());
        }
        catch {
            throw blocked('The mutation could not be safely prepared.', operation, target);
        }
        if (!normalizedSql)
            throw blocked('Enter one INSERT or UPDATE statement.', operation, target);
        return { operation, target, normalizedSql };
    }
}
exports.MutationSafetyService = MutationSafetyService;
function readTarget(statement, operation) {
    const relation = statement.relation;
    if (!isRecord(relation) || typeof relation.relname !== 'string' || !relation.relname) {
        throw blocked('The mutation target could not be identified.', operation);
    }
    if (typeof relation.schemaname !== 'string' || !relation.schemaname) {
        throw blocked('INSERT and UPDATE require an explicit schema-qualified target.', operation);
    }
    const schema = relation.schemaname;
    const normalizedSchema = schema.toLowerCase();
    const target = { schema, table: relation.relname };
    if (normalizedSchema === 'pg_catalog'
        || normalizedSchema === 'information_schema'
        || normalizedSchema.startsWith('pg_')) {
        throw blocked('Mutations against PostgreSQL system schemas are not allowed.', operation, target);
    }
    return target;
}
function hasReturningClause(statement) {
    const returning = statement.returningClause;
    if (!isRecord(returning))
        return false;
    return Array.isArray(returning.exprs) ? returning.exprs.length > 0 : true;
}
function containsModifyingCte(value) {
    if (Array.isArray(value))
        return value.some(containsModifyingCte);
    if (!isRecord(value))
        return false;
    const commonTableExpression = value.CommonTableExpr;
    if (isRecord(commonTableExpression) && isRecord(commonTableExpression.ctequery)) {
        const query = commonTableExpression.ctequery;
        if (isRecord(query.InsertStmt)
            || isRecord(query.UpdateStmt)
            || isRecord(query.DeleteStmt)
            || isRecord(query.MergeStmt))
            return true;
    }
    return Object.values(value).some(containsModifyingCte);
}
function blocked(message, operation = 'MUTATION', target) {
    return new MutationSafetyError({ message, operation, ...(target ? { target } : {}) });
}
function removeTrailingSemicolon(sql) {
    return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
