"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const queryBuilderModel_1 = require("../src/queryBuilder/queryBuilderModel");
const firstObject = { schema: 'public', name: 'orders', type: 'TABLE' };
const secondObject = { schema: 'support', name: 'tickets', type: 'VIEW' };
const firstColumns = [column(firstObject, 'id', 1), column(firstObject, 'status', 2, 'text')];
const secondColumns = [column(secondObject, 'ticket_id', 1), column(secondObject, 'opened_at', 2, 'timestamp without time zone')];
(0, node_test_1.default)('17: selecting another object resets Builder state without clearing SQL Editor', () => {
    const editorSql = 'SELECT manually_written_query;';
    let state = (0, queryBuilderModel_1.createQueryBuilderState)(selection(firstObject, firstColumns));
    state = (0, queryBuilderModel_1.selectAllColumns)(state);
    state = (0, queryBuilderModel_1.addWhereCondition)(state);
    state = {
        ...state,
        matchMode: 'OR',
        orderByColumn: 'status',
        orderDirection: 'DESC',
        limit: '999',
    };
    const nextState = (0, queryBuilderModel_1.synchronizeBuilderSelection)(state, selection(secondObject, secondColumns));
    strict_1.default.deepEqual(nextState.object, secondObject);
    strict_1.default.deepEqual(nextState.columns.map((item) => item.name), ['ticket_id', 'opened_at']);
    strict_1.default.deepEqual(nextState.selectedColumns, []);
    strict_1.default.deepEqual(nextState.conditions, []);
    strict_1.default.equal(nextState.matchMode, 'AND');
    strict_1.default.equal(nextState.orderByColumn, '');
    strict_1.default.equal(nextState.orderDirection, 'ASC');
    strict_1.default.equal(nextState.limit, '200');
    strict_1.default.equal(editorSql, 'SELECT manually_written_query;');
});
(0, node_test_1.default)('metadata refresh removes references to columns that disappeared', () => {
    let state = (0, queryBuilderModel_1.createQueryBuilderState)(selection(firstObject, firstColumns));
    state = (0, queryBuilderModel_1.selectAllColumns)(state);
    state = (0, queryBuilderModel_1.addWhereCondition)(state);
    state = { ...state, orderByColumn: 'status' };
    const refreshed = (0, queryBuilderModel_1.synchronizeBuilderSelection)(state, selection(firstObject, [column(firstObject, 'id', 1)]));
    strict_1.default.deepEqual(refreshed.selectedColumns, ['id']);
    strict_1.default.deepEqual(refreshed.conditions, [{ id: 1, column: 'id', operator: '=', value: '' }]);
    strict_1.default.equal(refreshed.orderByColumn, '');
});
(0, node_test_1.default)('18: non-empty SQL Editor requires explicit replacement confirmation', () => {
    const state = (0, queryBuilderModel_1.selectAllColumns)((0, queryBuilderModel_1.createQueryBuilderState)(selection(firstObject, firstColumns)));
    strict_1.default.equal((0, queryBuilderModel_1.prepareGeneratedSql)(state, '').requiresConfirmation, false);
    strict_1.default.equal((0, queryBuilderModel_1.prepareGeneratedSql)(state, '  \n ').requiresConfirmation, false);
    const request = (0, queryBuilderModel_1.prepareGeneratedSql)(state, 'SELECT existing;');
    strict_1.default.equal(request.requiresConfirmation, true);
    strict_1.default.match(request.sql, /^SELECT\n/);
});
(0, node_test_1.default)('19: Reset Builder preserves the selected object and metadata but not SQL Editor state', () => {
    const editorSql = 'SELECT hand_edited;';
    let state = (0, queryBuilderModel_1.createQueryBuilderState)(selection(firstObject, firstColumns));
    state = (0, queryBuilderModel_1.selectAllColumns)((0, queryBuilderModel_1.addWhereCondition)(state));
    state = {
        ...state,
        matchMode: 'OR',
        orderByColumn: 'status',
        orderDirection: 'DESC',
        limit: '50',
    };
    const reset = (0, queryBuilderModel_1.resetQueryBuilder)(state);
    strict_1.default.deepEqual(reset.object, firstObject);
    strict_1.default.deepEqual(reset.columns, firstColumns);
    strict_1.default.deepEqual(reset.selectedColumns, []);
    strict_1.default.deepEqual(reset.conditions, []);
    strict_1.default.equal(reset.matchMode, 'AND');
    strict_1.default.equal(reset.orderByColumn, '');
    strict_1.default.equal(reset.orderDirection, 'ASC');
    strict_1.default.equal(reset.limit, '200');
    strict_1.default.equal(editorSql, 'SELECT hand_edited;');
});
function selection(object, columns) {
    return { object, columns };
}
function column(object, name, ordinalPosition, dataType = 'integer') {
    return {
        schema: object.schema,
        objectName: object.name,
        name,
        dataType,
        nullable: true,
        ordinalPosition,
    };
}
