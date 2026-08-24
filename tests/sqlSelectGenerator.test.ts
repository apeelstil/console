import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseColumn, DatabaseObject } from '../shared/databaseMetadata';
import {
  generateSelectSql,
  QueryBuilderValidationError,
  type SelectQueryInput,
} from '../src/queryBuilder/sqlSelectGenerator';

const table: DatabaseObject = { schema: 'public', name: 'orders', type: 'TABLE' };
const columns: DatabaseColumn[] = [
  column('id', 'integer', 1, 'int4'),
  column('status', 'text', 2, 'text'),
  column('created_at', 'timestamp without time zone', 3, 'timestamp'),
  column('active', 'boolean', 4, 'bool'),
  column('external_id', 'USER-DEFINED', 5, 'support_identifier'),
];

test('1: ordinary SELECT uses selected metadata columns in ordinal order and no wildcard', () => {
  const sql = generateSelectSql(query({ selectedColumns: ['created_at', 'id', 'status'] }));

  assert.equal(sql, [
    'SELECT',
    '  "id",',
    '  "status",',
    '  "created_at"',
    'FROM "public"."orders"',
    'LIMIT 200;',
  ].join('\n'));
  assert.equal(sql.includes('*'), false);
});

test('2: schema, table, and column identifiers are always quoted', () => {
  const sql = generateSelectSql(query({
    object: { schema: 'Support Data', name: 'Order', type: 'TABLE' },
    columns: [column('select', 'text', 1)],
    selectedColumns: ['select'],
  }));

  assert.match(sql, /SELECT\n {2}"select"/);
  assert.match(sql, /FROM "Support Data"\."Order"/);
});

test('3: a double quote inside an identifier is doubled', () => {
  const sql = generateSelectSql(query({
    object: { schema: 'sup"port', name: 'ord"ers', type: 'TABLE' },
    columns: [column('my"column', 'text', 1)],
    selectedColumns: ['my"column'],
  }));

  assert.match(sql, /"my""column"/);
  assert.match(sql, /FROM "sup""port"\."ord""ers"/);
});

test("4: O'Reilly is escaped as a PostgreSQL string literal", () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['status'],
    conditions: [{ column: 'status', operator: '=', value: "O'Reilly" }],
  }));

  assert.match(sql, /"status" = 'O''Reilly'/);
});

test('5: valid integer, negative, and decimal numeric literals are not quoted', () => {
  const numericColumns = [
    column('quantity', 'integer', 1),
    column('balance', 'numeric', 2),
    column('ratio', 'double precision', 3),
  ];
  const sql = generateSelectSql(query({
    columns: numericColumns,
    selectedColumns: ['quantity'],
    conditions: [
      { column: 'quantity', operator: '=', value: '42' },
      { column: 'balance', operator: '<', value: '-10.50' },
      { column: 'ratio', operator: '>=', value: '.25' },
    ],
  }));

  assert.match(sql, /"quantity" = 42/);
  assert.match(sql, /"balance" < -10\.50/);
  assert.match(sql, /"ratio" >= \.25/);
});

test('6: invalid numeric input is rejected', () => {
  for (const value of ['', '1e3', '12.2.3', 'NOW()', '0; DROP TABLE orders']) {
    assert.throws(
      () => generateSelectSql(query({
        selectedColumns: ['id'],
        conditions: [{ column: 'id', operator: '=', value }],
      })),
      QueryBuilderValidationError,
    );
  }
});

test('7: boolean values are validated and generated as TRUE/FALSE without quotes', () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['active'],
    conditions: [
      { column: 'active', operator: '=', value: 'true' },
      { column: 'active', operator: '<>', value: 'FALSE' },
    ],
  }));

  assert.match(sql, /"active" = TRUE/);
  assert.match(sql, /"active" <> FALSE/);
  assert.throws(() => generateSelectSql(query({
    selectedColumns: ['active'],
    conditions: [{ column: 'active', operator: '=', value: 'yes' }],
  })), QueryBuilderValidationError);
});

test('8: IS NULL and IS NOT NULL do not generate values', () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['status'],
    conditions: [
      { column: 'status', operator: 'IS NULL', value: 'ignored' },
      { column: 'created_at', operator: 'IS NOT NULL', value: 'ignored' },
    ],
  }));

  assert.match(sql, /"status" IS NULL/);
  assert.match(sql, /"created_at" IS NOT NULL/);
  assert.equal(sql.includes('ignored'), false);
});

test('9: ALL conditions are joined with AND', () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['id'],
    matchMode: 'AND',
    conditions: [
      { column: 'id', operator: '>', value: '10' },
      { column: 'status', operator: '=', value: 'NEW' },
    ],
  }));

  assert.match(sql, /WHERE\n {2}"id" > 10\n {2}AND "status" = 'NEW'/);
});

test('10: ANY conditions are joined with OR', () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['id'],
    matchMode: 'OR',
    conditions: [
      { column: 'status', operator: '=', value: 'NEW' },
      { column: 'status', operator: '=', value: 'OPEN' },
    ],
  }));

  assert.match(sql, /"status" = 'NEW'\n {2}OR "status" = 'OPEN'/);
});

test('11: LIKE and ILIKE are available for text columns and values remain literals', () => {
  const sql = generateSelectSql(query({
    selectedColumns: ['status'],
    conditions: [
      { column: 'status', operator: 'LIKE', value: 'NEW%' },
      { column: 'status', operator: 'ILIKE', value: 'NOW()' },
    ],
  }));

  assert.match(sql, /"status" LIKE 'NEW%'/);
  assert.match(sql, /"status" ILIKE 'NOW\(\)'/);
});

test('12: ORDER BY supports one existing column with ASC or DESC', () => {
  const ascending = generateSelectSql(query({
    selectedColumns: ['id'],
    orderBy: { column: 'created_at', direction: 'ASC' },
  }));
  const descending = generateSelectSql(query({
    selectedColumns: ['id'],
    orderBy: { column: 'created_at', direction: 'DESC' },
  }));

  assert.match(ascending, /ORDER BY "created_at" ASC/);
  assert.match(descending, /ORDER BY "created_at" DESC/);
});

test('13: LIMIT accepts inclusive boundaries and rejects non-integers or out-of-range values', () => {
  assert.match(generateSelectSql(query({ limit: '1' })), /LIMIT 1;$/);
  assert.match(generateSelectSql(query({ limit: 10_000 })), /LIMIT 10000;$/);
  for (const limit of ['0', '10001', '2.5', '-1', '1e3', '']) {
    assert.throws(() => generateSelectSql(query({ limit })), QueryBuilderValidationError);
  }
});

test('14: unknown SELECT, WHERE, and ORDER BY columns are rejected', () => {
  assert.throws(
    () => generateSelectSql(query({ selectedColumns: ['missing'] })),
    /Неизвестный выбранный столбец/,
  );
  assert.throws(
    () => generateSelectSql(query({
      conditions: [{ column: 'missing', operator: '=', value: 'x' }],
    })),
    /Неизвестный столбец WHERE/,
  );
  assert.throws(
    () => generateSelectSql(query({ orderBy: { column: 'missing', direction: 'ASC' } })),
    /Неизвестный столбец ORDER BY/,
  );
});

test('15: an operator outside the allowlist for the metadata type is rejected', () => {
  assert.throws(() => generateSelectSql(query({
    selectedColumns: ['id'],
    conditions: [{ column: 'id', operator: 'ILIKE', value: '1' }],
  })), /недоступен/);
  assert.throws(() => generateSelectSql(query({
    selectedColumns: ['external_id'],
    conditions: [{ column: 'external_id', operator: '>', value: 'a' }],
  })), /недоступен/);
});

test('16: a VIEW is generated through the same validated SELECT path', () => {
  const sql = generateSelectSql(query({
    object: { schema: 'support', name: 'active_orders', type: 'VIEW' },
    selectedColumns: ['id', 'status'],
  }));

  assert.match(sql, /FROM "support"\."active_orders"/);
  assert.match(sql, /LIMIT 200;$/);
});

function query(overrides: Partial<SelectQueryInput> = {}): SelectQueryInput {
  return {
    object: table,
    columns,
    selectedColumns: ['id'],
    conditions: [],
    matchMode: 'AND',
    limit: 200,
    ...overrides,
  };
}

function column(
  name: string,
  dataType: string,
  ordinalPosition: number,
  nativeType?: string,
): DatabaseColumn {
  return {
    schema: 'public',
    objectName: 'orders',
    name,
    dataType,
    nullable: true,
    ordinalPosition,
    ...(nativeType ? { nativeType } : {}),
  };
}
