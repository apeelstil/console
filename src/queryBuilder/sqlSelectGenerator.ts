import type { DatabaseColumn, DatabaseObject } from '../../shared/databaseMetadata';

export const SQL_OPERATORS = [
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
] as const;

export type SqlOperator = (typeof SQL_OPERATORS)[number];
export type ConditionMatchMode = 'AND' | 'OR';
export type SortDirection = 'ASC' | 'DESC';
export type ColumnValueKind = 'numeric' | 'temporal' | 'text' | 'boolean' | 'unknown';

export interface SelectWhereCondition {
  column: string;
  operator: SqlOperator;
  value: string;
}

export interface SelectOrderBy {
  column: string;
  direction: SortDirection;
}

export interface SelectQueryInput {
  object: DatabaseObject;
  columns: DatabaseColumn[];
  selectedColumns: string[];
  conditions: SelectWhereCondition[];
  matchMode: ConditionMatchMode;
  orderBy?: SelectOrderBy;
  limit: string | number;
}

const COMMON_OPERATORS: readonly SqlOperator[] = ['=', '<>', 'IS NULL', 'IS NOT NULL'];
const COMPARISON_OPERATORS: readonly SqlOperator[] = [
  '=', '<>', 'IS NULL', 'IS NOT NULL', '>', '>=', '<', '<=',
];
const TEXT_OPERATORS: readonly SqlOperator[] = [
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

export class QueryBuilderValidationError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'QueryBuilderValidationError';
  }
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!identifier) throw new QueryBuilderValidationError('Database identifiers must not be empty.');
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quotePostgresStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function getColumnValueKind(column: DatabaseColumn): ColumnValueKind {
  const dataType = column.dataType.trim().toLowerCase();
  if (dataType === 'boolean') return 'boolean';
  if (NUMERIC_TYPES.has(dataType)) return 'numeric';
  if (TEMPORAL_TYPES.has(dataType)) return 'temporal';
  if (TEXT_TYPES.has(dataType)) return 'text';
  return 'unknown';
}

export function getAllowedOperators(column: DatabaseColumn): readonly SqlOperator[] {
  const valueKind = getColumnValueKind(column);
  if (valueKind === 'numeric' || valueKind === 'temporal') return COMPARISON_OPERATORS;
  if (valueKind === 'text') return TEXT_OPERATORS;
  return COMMON_OPERATORS;
}

export function operatorNeedsValue(operator: SqlOperator): boolean {
  return operator !== 'IS NULL' && operator !== 'IS NOT NULL';
}

export function isStrictNumericLiteral(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim());
}

export function generateSelectSql(input: SelectQueryInput): string {
  validateObject(input.object);
  const columns = [...input.columns].sort(
    (first, second) => first.ordinalPosition - second.ordinalPosition,
  );
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
    if (!column) throw new QueryBuilderValidationError(`Unknown WHERE column: ${condition.column}`);

    const allowedOperators = getAllowedOperators(column);
    if (!allowedOperators.includes(condition.operator)) {
      throw new QueryBuilderValidationError(
        `Operator ${condition.operator} is not allowed for column ${condition.column}.`,
      );
    }

    const expression = formatCondition(column, condition);
    const connector = index === 0 ? '' : `${input.matchMode} `;
    return `  ${connector}${expression}`;
  });

  const limit = parseQueryLimit(input.limit);
  const sqlLines = [
    'SELECT',
    ...orderedSelection.map((column, index) => (
      `  ${quotePostgresIdentifier(column.name)}${index < orderedSelection.length - 1 ? ',' : ''}`
    )),
    `FROM ${quotePostgresIdentifier(input.object.schema)}.${quotePostgresIdentifier(input.object.name)}`,
  ];

  if (whereLines.length > 0) sqlLines.push('WHERE', ...whereLines);

  if (input.orderBy) {
    if (!columnsByName.has(input.orderBy.column)) {
      throw new QueryBuilderValidationError(`Unknown ORDER BY column: ${input.orderBy.column}`);
    }
    if (input.orderBy.direction !== 'ASC' && input.orderBy.direction !== 'DESC') {
      throw new QueryBuilderValidationError('Invalid ORDER BY direction.');
    }
    sqlLines.push(
      `ORDER BY ${quotePostgresIdentifier(input.orderBy.column)} ${input.orderBy.direction}`,
    );
  }

  sqlLines.push(`LIMIT ${limit};`);
  return sqlLines.join('\n');
}

function validateObject(object: DatabaseObject): void {
  if (object.type !== 'TABLE' && object.type !== 'VIEW') {
    throw new QueryBuilderValidationError('Only tables and views are supported.');
  }
  quotePostgresIdentifier(object.schema);
  quotePostgresIdentifier(object.name);
}

function formatCondition(column: DatabaseColumn, condition: SelectWhereCondition): string {
  const identifier = quotePostgresIdentifier(column.name);
  if (!operatorNeedsValue(condition.operator)) return `${identifier} ${condition.operator}`;

  const kind = getColumnValueKind(column);
  if (kind === 'numeric') {
    if (!isStrictNumericLiteral(condition.value)) {
      throw new QueryBuilderValidationError(
        `Enter a valid numeric value for column ${column.name}.`,
      );
    }
    return `${identifier} ${condition.operator} ${condition.value.trim()}`;
  }

  if (kind === 'boolean') {
    const booleanValue = condition.value.trim().toUpperCase();
    if (booleanValue !== 'TRUE' && booleanValue !== 'FALSE') {
      throw new QueryBuilderValidationError(
        `Select TRUE or FALSE for column ${column.name}.`,
      );
    }
    return `${identifier} ${condition.operator} ${booleanValue}`;
  }

  return `${identifier} ${condition.operator} ${quotePostgresStringLiteral(condition.value)}`;
}

function parseQueryLimit(value: string | number): number {
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
