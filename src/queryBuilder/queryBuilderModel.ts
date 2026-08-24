import type { DatabaseColumn, DatabaseObject } from '../../shared/databaseMetadata';
import type { DatabaseExplorerSelection } from '../databaseExplorerController';
import {
  generateSelectSql,
  getAllowedOperators,
  type ConditionMatchMode,
  type SelectWhereCondition,
  type SortDirection,
  type SqlOperator,
} from './sqlSelectGenerator';

export const DEFAULT_QUERY_LIMIT = '200';

export interface QueryBuilderCondition extends SelectWhereCondition {
  id: number;
}

export interface QueryBuilderState {
  object?: DatabaseObject;
  columns: DatabaseColumn[];
  selectedColumns: string[];
  conditions: QueryBuilderCondition[];
  matchMode: ConditionMatchMode;
  orderByColumn: string;
  orderDirection: SortDirection;
  limit: string;
  nextConditionId: number;
}

export interface GeneratedSqlRequest {
  sql: string;
  requiresConfirmation: boolean;
}

export function createQueryBuilderState(
  selection?: DatabaseExplorerSelection,
): QueryBuilderState {
  return {
    ...(selection ? { object: { ...selection.object } } : {}),
    columns: sortColumns(selection?.columns ?? []),
    selectedColumns: [],
    conditions: [],
    matchMode: 'AND',
    orderByColumn: '',
    orderDirection: 'ASC',
    limit: DEFAULT_QUERY_LIMIT,
    nextConditionId: 1,
  };
}

export function synchronizeBuilderSelection(
  state: QueryBuilderState,
  selection?: DatabaseExplorerSelection,
): QueryBuilderState {
  if (!selection) return createQueryBuilderState();
  if (!state.object || objectKey(state.object) !== objectKey(selection.object)) {
    return createQueryBuilderState(selection);
  }

  const columns = sortColumns(selection.columns);
  const availableNames = new Set(columns.map((column) => column.name));
  return {
    ...state,
    object: { ...selection.object },
    columns,
    selectedColumns: state.selectedColumns.filter((name) => availableNames.has(name)),
    conditions: state.conditions.filter((condition) => availableNames.has(condition.column)),
    orderByColumn: availableNames.has(state.orderByColumn) ? state.orderByColumn : '',
  };
}

export function resetQueryBuilder(state: QueryBuilderState): QueryBuilderState {
  const selection = state.object ? { object: state.object, columns: state.columns } : undefined;
  return createQueryBuilderState(selection);
}

export function selectAllColumns(state: QueryBuilderState): QueryBuilderState {
  return { ...state, selectedColumns: state.columns.map((column) => column.name) };
}

export function clearSelectedColumns(state: QueryBuilderState): QueryBuilderState {
  return { ...state, selectedColumns: [] };
}

export function toggleSelectedColumn(state: QueryBuilderState, columnName: string): QueryBuilderState {
  if (!state.columns.some((column) => column.name === columnName)) return state;
  const selected = state.selectedColumns.includes(columnName);
  return {
    ...state,
    selectedColumns: selected
      ? state.selectedColumns.filter((name) => name !== columnName)
      : state.columns
        .filter((column) => column.name === columnName || state.selectedColumns.includes(column.name))
        .map((column) => column.name),
  };
}

export function addWhereCondition(state: QueryBuilderState): QueryBuilderState {
  const firstColumn = state.columns[0];
  if (!firstColumn) return state;
  const condition: QueryBuilderCondition = {
    id: state.nextConditionId,
    column: firstColumn.name,
    operator: '=',
    value: defaultConditionValue(firstColumn, '='),
  };
  return {
    ...state,
    conditions: [...state.conditions, condition],
    nextConditionId: state.nextConditionId + 1,
  };
}

export function updateWhereCondition(
  state: QueryBuilderState,
  id: number,
  update: Partial<Pick<QueryBuilderCondition, 'column' | 'operator' | 'value'>>,
): QueryBuilderState {
  return {
    ...state,
    conditions: state.conditions.map((condition) => {
      if (condition.id !== id) return condition;
      const columnName = update.column ?? condition.column;
      const column = state.columns.find((candidate) => candidate.name === columnName);
      if (!column) return condition;
      const allowed = getAllowedOperators(column);
      const requestedOperator = update.operator ?? condition.operator;
      const operator = allowed.includes(requestedOperator) ? requestedOperator : allowed[0] ?? '=';
      const columnChanged = columnName !== condition.column;
      const operatorChanged = operator !== condition.operator;
      const value = update.value ?? (
        columnChanged || operatorChanged
          ? defaultConditionValue(column, operator)
          : condition.value
      );
      return { ...condition, column: columnName, operator, value };
    }),
  };
}

export function removeWhereCondition(state: QueryBuilderState, id: number): QueryBuilderState {
  return { ...state, conditions: state.conditions.filter((condition) => condition.id !== id) };
}

export function prepareGeneratedSql(
  state: QueryBuilderState,
  currentEditorSql: string,
): GeneratedSqlRequest {
  if (!state.object) throw new Error('Select a table or view in Database Explorer.');
  const sql = generateSelectSql({
    object: state.object,
    columns: state.columns,
    selectedColumns: state.selectedColumns,
    conditions: state.conditions,
    matchMode: state.matchMode,
    ...(state.orderByColumn
      ? { orderBy: { column: state.orderByColumn, direction: state.orderDirection } }
      : {}),
    limit: state.limit,
  });
  return { sql, requiresConfirmation: currentEditorSql.trim().length > 0 };
}

function defaultConditionValue(column: DatabaseColumn, operator: SqlOperator): string {
  if (operator === 'IS NULL' || operator === 'IS NOT NULL') return '';
  return column.dataType.trim().toLowerCase() === 'boolean' ? 'TRUE' : '';
}

function sortColumns(columns: DatabaseColumn[]): DatabaseColumn[] {
  return [...columns].sort((first, second) => first.ordinalPosition - second.ordinalPosition);
}

function objectKey(object: DatabaseObject): string {
  return JSON.stringify([object.schema, object.name, object.type]);
}
