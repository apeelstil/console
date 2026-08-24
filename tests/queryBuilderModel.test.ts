import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseColumn, DatabaseObject } from '../shared/databaseMetadata';
import type { DatabaseExplorerSelection } from '../src/databaseExplorerController';
import {
  addWhereCondition,
  createQueryBuilderState,
  prepareGeneratedSql,
  resetQueryBuilder,
  selectAllColumns,
  synchronizeBuilderSelection,
} from '../src/queryBuilder/queryBuilderModel';

const firstObject: DatabaseObject = { schema: 'public', name: 'orders', type: 'TABLE' };
const secondObject: DatabaseObject = { schema: 'support', name: 'tickets', type: 'VIEW' };
const firstColumns = [column(firstObject, 'id', 1), column(firstObject, 'status', 2, 'text')];
const secondColumns = [column(secondObject, 'ticket_id', 1), column(secondObject, 'opened_at', 2, 'timestamp without time zone')];

test('17: selecting another object resets Builder state without clearing SQL Editor', () => {
  const editorSql = 'SELECT manually_written_query;';
  let state = createQueryBuilderState(selection(firstObject, firstColumns));
  state = selectAllColumns(state);
  state = addWhereCondition(state);
  state = {
    ...state,
    matchMode: 'OR',
    orderByColumn: 'status',
    orderDirection: 'DESC',
    limit: '999',
  };

  const nextState = synchronizeBuilderSelection(state, selection(secondObject, secondColumns));

  assert.deepEqual(nextState.object, secondObject);
  assert.deepEqual(nextState.columns.map((item) => item.name), ['ticket_id', 'opened_at']);
  assert.deepEqual(nextState.selectedColumns, []);
  assert.deepEqual(nextState.conditions, []);
  assert.equal(nextState.matchMode, 'AND');
  assert.equal(nextState.orderByColumn, '');
  assert.equal(nextState.orderDirection, 'ASC');
  assert.equal(nextState.limit, '200');
  assert.equal(editorSql, 'SELECT manually_written_query;');
});

test('metadata refresh removes references to columns that disappeared', () => {
  let state = createQueryBuilderState(selection(firstObject, firstColumns));
  state = selectAllColumns(state);
  state = addWhereCondition(state);
  state = { ...state, orderByColumn: 'status' };

  const refreshed = synchronizeBuilderSelection(
    state,
    selection(firstObject, [column(firstObject, 'id', 1)]),
  );

  assert.deepEqual(refreshed.selectedColumns, ['id']);
  assert.deepEqual(refreshed.conditions, [{ id: 1, column: 'id', operator: '=', value: '' }]);
  assert.equal(refreshed.orderByColumn, '');
});

test('18: non-empty SQL Editor requires explicit replacement confirmation', () => {
  const state = selectAllColumns(createQueryBuilderState(selection(firstObject, firstColumns)));

  assert.equal(prepareGeneratedSql(state, '').requiresConfirmation, false);
  assert.equal(prepareGeneratedSql(state, '  \n ').requiresConfirmation, false);
  const request = prepareGeneratedSql(state, 'SELECT existing;');
  assert.equal(request.requiresConfirmation, true);
  assert.match(request.sql, /^SELECT\n/);
});

test('19: Reset Builder preserves the selected object and metadata but not SQL Editor state', () => {
  const editorSql = 'SELECT hand_edited;';
  let state = createQueryBuilderState(selection(firstObject, firstColumns));
  state = selectAllColumns(addWhereCondition(state));
  state = {
    ...state,
    matchMode: 'OR',
    orderByColumn: 'status',
    orderDirection: 'DESC',
    limit: '50',
  };

  const reset = resetQueryBuilder(state);

  assert.deepEqual(reset.object, firstObject);
  assert.deepEqual(reset.columns, firstColumns);
  assert.deepEqual(reset.selectedColumns, []);
  assert.deepEqual(reset.conditions, []);
  assert.equal(reset.matchMode, 'AND');
  assert.equal(reset.orderByColumn, '');
  assert.equal(reset.orderDirection, 'ASC');
  assert.equal(reset.limit, '200');
  assert.equal(editorSql, 'SELECT hand_edited;');
});

function selection(object: DatabaseObject, columns: DatabaseColumn[]): DatabaseExplorerSelection {
  return { object, columns };
}

function column(
  object: DatabaseObject,
  name: string,
  ordinalPosition: number,
  dataType = 'integer',
): DatabaseColumn {
  return {
    schema: object.schema,
    objectName: object.name,
    name,
    dataType,
    nullable: true,
    ordinalPosition,
  };
}
