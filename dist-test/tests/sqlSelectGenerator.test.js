"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const sqlSelectGenerator_1 = require("../src/queryBuilder/sqlSelectGenerator");
const table = { schema: 'public', name: 'orders', type: 'TABLE' };
const columns = [
    column('id', 'integer', 1, 'int4'),
    column('status', 'text', 2, 'text'),
    column('created_at', 'timestamp without time zone', 3, 'timestamp'),
    column('active', 'boolean', 4, 'bool'),
    column('external_id', 'USER-DEFINED', 5, 'support_identifier'),
];
(0, node_test_1.default)('1: ordinary SELECT uses selected metadata columns in ordinal order and no wildcard', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({ selectedColumns: ['created_at', 'id', 'status'] }));
    strict_1.default.equal(sql, [
        'SELECT',
        '  "id",',
        '  "status",',
        '  "created_at"',
        'FROM "public"."orders"',
        'LIMIT 200;',
    ].join('\n'));
    strict_1.default.equal(sql.includes('*'), false);
});
(0, node_test_1.default)('2: schema, table, and column identifiers are always quoted', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        object: { schema: 'Support Data', name: 'Order', type: 'TABLE' },
        columns: [column('select', 'text', 1)],
        selectedColumns: ['select'],
    }));
    strict_1.default.match(sql, /SELECT\n {2}"select"/);
    strict_1.default.match(sql, /FROM "Support Data"\."Order"/);
});
(0, node_test_1.default)('3: a double quote inside an identifier is doubled', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        object: { schema: 'sup"port', name: 'ord"ers', type: 'TABLE' },
        columns: [column('my"column', 'text', 1)],
        selectedColumns: ['my"column'],
    }));
    strict_1.default.match(sql, /"my""column"/);
    strict_1.default.match(sql, /FROM "sup""port"\."ord""ers"/);
});
(0, node_test_1.default)("4: O'Reilly is escaped as a PostgreSQL string literal", () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['status'],
        conditions: [{ column: 'status', operator: '=', value: "O'Reilly" }],
    }));
    strict_1.default.match(sql, /"status" = 'O''Reilly'/);
});
(0, node_test_1.default)('5: valid integer, negative, and decimal numeric literals are not quoted', () => {
    const numericColumns = [
        column('quantity', 'integer', 1),
        column('balance', 'numeric', 2),
        column('ratio', 'double precision', 3),
    ];
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        columns: numericColumns,
        selectedColumns: ['quantity'],
        conditions: [
            { column: 'quantity', operator: '=', value: '42' },
            { column: 'balance', operator: '<', value: '-10.50' },
            { column: 'ratio', operator: '>=', value: '.25' },
        ],
    }));
    strict_1.default.match(sql, /"quantity" = 42/);
    strict_1.default.match(sql, /"balance" < -10\.50/);
    strict_1.default.match(sql, /"ratio" >= \.25/);
});
(0, node_test_1.default)('6: invalid numeric input is rejected', () => {
    for (const value of ['', '1e3', '12.2.3', 'NOW()', '0; DROP TABLE orders']) {
        strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({
            selectedColumns: ['id'],
            conditions: [{ column: 'id', operator: '=', value }],
        })), sqlSelectGenerator_1.QueryBuilderValidationError);
    }
});
(0, node_test_1.default)('7: boolean values are validated and generated as TRUE/FALSE without quotes', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['active'],
        conditions: [
            { column: 'active', operator: '=', value: 'true' },
            { column: 'active', operator: '<>', value: 'FALSE' },
        ],
    }));
    strict_1.default.match(sql, /"active" = TRUE/);
    strict_1.default.match(sql, /"active" <> FALSE/);
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['active'],
        conditions: [{ column: 'active', operator: '=', value: 'yes' }],
    })), sqlSelectGenerator_1.QueryBuilderValidationError);
});
(0, node_test_1.default)('8: IS NULL and IS NOT NULL do not generate values', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['status'],
        conditions: [
            { column: 'status', operator: 'IS NULL', value: 'ignored' },
            { column: 'created_at', operator: 'IS NOT NULL', value: 'ignored' },
        ],
    }));
    strict_1.default.match(sql, /"status" IS NULL/);
    strict_1.default.match(sql, /"created_at" IS NOT NULL/);
    strict_1.default.equal(sql.includes('ignored'), false);
});
(0, node_test_1.default)('9: ALL conditions are joined with AND', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['id'],
        matchMode: 'AND',
        conditions: [
            { column: 'id', operator: '>', value: '10' },
            { column: 'status', operator: '=', value: 'NEW' },
        ],
    }));
    strict_1.default.match(sql, /WHERE\n {2}"id" > 10\n {2}AND "status" = 'NEW'/);
});
(0, node_test_1.default)('10: ANY conditions are joined with OR', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['id'],
        matchMode: 'OR',
        conditions: [
            { column: 'status', operator: '=', value: 'NEW' },
            { column: 'status', operator: '=', value: 'OPEN' },
        ],
    }));
    strict_1.default.match(sql, /"status" = 'NEW'\n {2}OR "status" = 'OPEN'/);
});
(0, node_test_1.default)('11: LIKE and ILIKE are available for text columns and values remain literals', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['status'],
        conditions: [
            { column: 'status', operator: 'LIKE', value: 'NEW%' },
            { column: 'status', operator: 'ILIKE', value: 'NOW()' },
        ],
    }));
    strict_1.default.match(sql, /"status" LIKE 'NEW%'/);
    strict_1.default.match(sql, /"status" ILIKE 'NOW\(\)'/);
});
(0, node_test_1.default)('12: ORDER BY supports one existing column with ASC or DESC', () => {
    const ascending = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['id'],
        orderBy: { column: 'created_at', direction: 'ASC' },
    }));
    const descending = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['id'],
        orderBy: { column: 'created_at', direction: 'DESC' },
    }));
    strict_1.default.match(ascending, /ORDER BY "created_at" ASC/);
    strict_1.default.match(descending, /ORDER BY "created_at" DESC/);
});
(0, node_test_1.default)('13: LIMIT accepts inclusive boundaries and rejects non-integers or out-of-range values', () => {
    strict_1.default.match((0, sqlSelectGenerator_1.generateSelectSql)(query({ limit: '1' })), /LIMIT 1;$/);
    strict_1.default.match((0, sqlSelectGenerator_1.generateSelectSql)(query({ limit: 10_000 })), /LIMIT 10000;$/);
    for (const limit of ['0', '10001', '2.5', '-1', '1e3', '']) {
        strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({ limit })), sqlSelectGenerator_1.QueryBuilderValidationError);
    }
});
(0, node_test_1.default)('14: unknown SELECT, WHERE, and ORDER BY columns are rejected', () => {
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({ selectedColumns: ['missing'] })), /Unknown selected column/);
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({
        conditions: [{ column: 'missing', operator: '=', value: 'x' }],
    })), /Unknown WHERE column/);
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({ orderBy: { column: 'missing', direction: 'ASC' } })), /Unknown ORDER BY column/);
});
(0, node_test_1.default)('15: an operator outside the allowlist for the metadata type is rejected', () => {
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['id'],
        conditions: [{ column: 'id', operator: 'ILIKE', value: '1' }],
    })), /not allowed/);
    strict_1.default.throws(() => (0, sqlSelectGenerator_1.generateSelectSql)(query({
        selectedColumns: ['external_id'],
        conditions: [{ column: 'external_id', operator: '>', value: 'a' }],
    })), /not allowed/);
});
(0, node_test_1.default)('16: a VIEW is generated through the same validated SELECT path', () => {
    const sql = (0, sqlSelectGenerator_1.generateSelectSql)(query({
        object: { schema: 'support', name: 'active_orders', type: 'VIEW' },
        selectedColumns: ['id', 'status'],
    }));
    strict_1.default.match(sql, /FROM "support"\."active_orders"/);
    strict_1.default.match(sql, /LIMIT 200;$/);
});
function query(overrides = {}) {
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
function column(name, dataType, ordinalPosition, nativeType) {
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
