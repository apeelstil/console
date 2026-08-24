"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_QUERY_LIMIT = void 0;
exports.createQueryBuilderState = createQueryBuilderState;
exports.synchronizeBuilderSelection = synchronizeBuilderSelection;
exports.resetQueryBuilder = resetQueryBuilder;
exports.selectAllColumns = selectAllColumns;
exports.clearSelectedColumns = clearSelectedColumns;
exports.toggleSelectedColumn = toggleSelectedColumn;
exports.addWhereCondition = addWhereCondition;
exports.updateWhereCondition = updateWhereCondition;
exports.removeWhereCondition = removeWhereCondition;
exports.prepareGeneratedSql = prepareGeneratedSql;
const sqlSelectGenerator_1 = require("./sqlSelectGenerator");
exports.DEFAULT_QUERY_LIMIT = '200';
function createQueryBuilderState(selection) {
    return {
        ...(selection ? { object: { ...selection.object } } : {}),
        columns: sortColumns(selection?.columns ?? []),
        selectedColumns: [],
        conditions: [],
        matchMode: 'AND',
        orderByColumn: '',
        orderDirection: 'ASC',
        limit: exports.DEFAULT_QUERY_LIMIT,
        nextConditionId: 1,
    };
}
function synchronizeBuilderSelection(state, selection) {
    if (!selection)
        return createQueryBuilderState();
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
function resetQueryBuilder(state) {
    const selection = state.object ? { object: state.object, columns: state.columns } : undefined;
    return createQueryBuilderState(selection);
}
function selectAllColumns(state) {
    return { ...state, selectedColumns: state.columns.map((column) => column.name) };
}
function clearSelectedColumns(state) {
    return { ...state, selectedColumns: [] };
}
function toggleSelectedColumn(state, columnName) {
    if (!state.columns.some((column) => column.name === columnName))
        return state;
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
function addWhereCondition(state) {
    const firstColumn = state.columns[0];
    if (!firstColumn)
        return state;
    const condition = {
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
function updateWhereCondition(state, id, update) {
    return {
        ...state,
        conditions: state.conditions.map((condition) => {
            if (condition.id !== id)
                return condition;
            const columnName = update.column ?? condition.column;
            const column = state.columns.find((candidate) => candidate.name === columnName);
            if (!column)
                return condition;
            const allowed = (0, sqlSelectGenerator_1.getAllowedOperators)(column);
            const requestedOperator = update.operator ?? condition.operator;
            const operator = allowed.includes(requestedOperator) ? requestedOperator : allowed[0] ?? '=';
            const columnChanged = columnName !== condition.column;
            const operatorChanged = operator !== condition.operator;
            const value = update.value ?? (columnChanged || operatorChanged
                ? defaultConditionValue(column, operator)
                : condition.value);
            return { ...condition, column: columnName, operator, value };
        }),
    };
}
function removeWhereCondition(state, id) {
    return { ...state, conditions: state.conditions.filter((condition) => condition.id !== id) };
}
function prepareGeneratedSql(state, currentEditorSql) {
    if (!state.object)
        throw new Error('Select a table or view in Database Explorer.');
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)({
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
function defaultConditionValue(column, operator) {
    if (operator === 'IS NULL' || operator === 'IS NOT NULL')
        return '';
    return column.dataType.trim().toLowerCase() === 'boolean' ? 'TRUE' : '';
}
function sortColumns(columns) {
    return [...columns].sort((first, second) => first.ordinalPosition - second.ordinalPosition);
}
function objectKey(object) {
    return JSON.stringify([object.schema, object.name, object.type]);
}
