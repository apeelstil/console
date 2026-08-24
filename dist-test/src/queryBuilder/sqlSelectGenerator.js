"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryBuilderValidationError = exports.SQL_OPERATORS = void 0;
exports.quotePostgresIdentifier = quotePostgresIdentifier;
exports.quotePostgresStringLiteral = quotePostgresStringLiteral;
exports.getColumnValueKind = getColumnValueKind;
exports.getAllowedOperators = getAllowedOperators;
exports.operatorNeedsValue = operatorNeedsValue;
exports.isStrictNumericLiteral = isStrictNumericLiteral;
exports.generateSelectSql = generateSelectSql;
exports.SQL_OPERATORS = [
    '=',
    '<>',
    'IS NULL',
    'IS NOT NULL',
    '>',
    '>=',
    '<',
    '<=',
    'LIKE',
    'ILIKE',
];
const COMMON_OPERATORS = ['=', '<>', 'IS NULL', 'IS NOT NULL'];
const COMPARISON_OPERATORS = [
    '=', '<>', 'IS NULL', 'IS NOT NULL', '>', '>=', '<', '<=',
];
const TEXT_OPERATORS = [
    '=', '<>', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE',
];
const NUMERIC_TYPES = new Set([
    'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision',
    'smallserial', 'serial', 'bigserial', 'money',
]);
const TEMPORAL_TYPES = new Set([
    'date', 'time without time zone', 'time with time zone',
    'timestamp without time zone', 'timestamp with time zone', 'interval',
]);
const TEXT_TYPES = new Set([
    'character', 'character varying', 'text', 'char', 'varchar',
]);
class QueryBuilderValidationError extends Error {
    safeMessage;
    constructor(safeMessage) {
        super(safeMessage);
        this.safeMessage = safeMessage;
        this.name = 'QueryBuilderValidationError';
    }
}
exports.QueryBuilderValidationError = QueryBuilderValidationError;
function quotePostgresIdentifier(identifier) {
    if (!identifier)
        throw new QueryBuilderValidationError('Database identifiers must not be empty.');
    return `"${identifier.replace(/"/g, '""')}"`;
}
function quotePostgresStringLiteral(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function getColumnValueKind(column) {
    const dataType = column.dataType.trim().toLowerCase();
    if (dataType === 'boolean')
        return 'boolean';
    if (NUMERIC_TYPES.has(dataType))
        return 'numeric';
    if (TEMPORAL_TYPES.has(dataType))
        return 'temporal';
    if (TEXT_TYPES.has(dataType))
        return 'text';
    return 'unknown';
}
function getAllowedOperators(column) {
    const valueKind = getColumnValueKind(column);
    if (valueKind === 'numeric' || valueKind === 'temporal')
        return COMPARISON_OPERATORS;
    if (valueKind === 'text')
        return TEXT_OPERATORS;
    return COMMON_OPERATORS;
}
function operatorNeedsValue(operator) {
    return operator !== 'IS NULL' && operator !== 'IS NOT NULL';
}
function isStrictNumericLiteral(value) {
    return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim());
}
function generateSelectSql(input) {
    validateObject(input.object);
    const columns = [...input.columns].sort((first, second) => first.ordinalPosition - second.ordinalPosition);
    const columnsByName = new Map(columns.map((column) => [column.name, column]));
    const selectedNames = new Set(input.selectedColumns);
    for (const selectedColumn of selectedNames) {
        if (!columnsByName.has(selectedColumn)) {
            throw new QueryBuilderValidationError(`Unknown selected column: ${selectedColumn}`);
        }
    }
    const orderedSelection = columns.filter((column) => selectedNames.has(column.name));
    if (orderedSelection.length === 0) {
        throw new QueryBuilderValidationError('Select at least one column.');
    }
    if (input.matchMode !== 'AND' && input.matchMode !== 'OR') {
        throw new QueryBuilderValidationError('Invalid WHERE match mode.');
    }
    const whereLines = input.conditions.map((condition, index) => {
        const column = columnsByName.get(condition.column);
        if (!column)
            throw new QueryBuilderValidationError(`Unknown WHERE column: ${condition.column}`);
        const allowedOperators = getAllowedOperators(column);
        if (!allowedOperators.includes(condition.operator)) {
            throw new QueryBuilderValidationError(`Operator ${condition.operator} is not allowed for column ${condition.column}.`);
        }
        const expression = formatCondition(column, condition);
        const connector = index === 0 ? '' : `${input.matchMode} `;
        return `  ${connector}${expression}`;
    });
    const limit = parseQueryLimit(input.limit);
    const sqlLines = [
        'SELECT',
        ...orderedSelection.map((column, index) => (`  ${quotePostgresIdentifier(column.name)}${index < orderedSelection.length - 1 ? ',' : ''}`)),
        `FROM ${quotePostgresIdentifier(input.object.schema)}.${quotePostgresIdentifier(input.object.name)}`,
    ];
    if (whereLines.length > 0)
        sqlLines.push('WHERE', ...whereLines);
    if (input.orderBy) {
        if (!columnsByName.has(input.orderBy.column)) {
            throw new QueryBuilderValidationError(`Unknown ORDER BY column: ${input.orderBy.column}`);
        }
        if (input.orderBy.direction !== 'ASC' && input.orderBy.direction !== 'DESC') {
            throw new QueryBuilderValidationError('Invalid ORDER BY direction.');
        }
        sqlLines.push(`ORDER BY ${quotePostgresIdentifier(input.orderBy.column)} ${input.orderBy.direction}`);
    }
    sqlLines.push(`LIMIT ${limit};`);
    return sqlLines.join('\n');
}
function validateObject(object) {
    if (object.type !== 'TABLE' && object.type !== 'VIEW') {
        throw new QueryBuilderValidationError('Only tables and views are supported.');
    }
    quotePostgresIdentifier(object.schema);
    quotePostgresIdentifier(object.name);
}
function formatCondition(column, condition) {
    const identifier = quotePostgresIdentifier(column.name);
    if (!operatorNeedsValue(condition.operator))
        return `${identifier} ${condition.operator}`;
    const kind = getColumnValueKind(column);
    if (kind === 'numeric') {
        if (!isStrictNumericLiteral(condition.value)) {
            throw new QueryBuilderValidationError(`Enter a valid numeric value for column ${column.name}.`);
        }
        return `${identifier} ${condition.operator} ${condition.value.trim()}`;
    }
    if (kind === 'boolean') {
        const booleanValue = condition.value.trim().toUpperCase();
        if (booleanValue !== 'TRUE' && booleanValue !== 'FALSE') {
            throw new QueryBuilderValidationError(`Select TRUE or FALSE for column ${column.name}.`);
        }
        return `${identifier} ${condition.operator} ${booleanValue}`;
    }
    return `${identifier} ${condition.operator} ${quotePostgresStringLiteral(condition.value)}`;
}
function parseQueryLimit(value) {
    const normalized = typeof value === 'number' ? String(value) : value.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
        throw new QueryBuilderValidationError('LIMIT must be an integer from 1 to 10000.');
    }
    const limit = Number(normalized);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new QueryBuilderValidationError('LIMIT must be an integer from 1 to 10000.');
    }
    return limit;
}
