"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const sqlSafetyService_1 = require("../electron/postgres/sqlSafetyService");
const service = new sqlSafetyService_1.SqlSafetyService();
(0, node_test_1.default)('1: an ordinary SELECT is allowed and wrapped with a server-side 1001 row cap', async () => {
    const result = await service.validateSelect('SELECT id, status FROM public.orders ORDER BY id;');
    strict_1.default.match(result.normalizedSql, /^SELECT/);
    strict_1.default.match(result.executableSql, /^SELECT \*\nFROM \(/);
    strict_1.default.match(result.executableSql, /ORDER BY/);
    strict_1.default.match(result.executableSql, /\) AS "__supra_query_result"\nLIMIT 1001;$/);
});
(0, node_test_1.default)('2: SELECT WITH containing a SELECT CTE is allowed', async () => {
    const result = await service.validateSelect('WITH recent AS (SELECT id FROM orders WHERE created_at > CURRENT_DATE) SELECT id FROM recent');
    strict_1.default.match(result.normalizedSql, /^WITH/);
    strict_1.default.match(result.executableSql, /LIMIT 1001;$/);
});
(0, node_test_1.default)('3: JOIN, subquery, and UNION SELECT forms are allowed', async () => {
    const allowed = [
        'SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id',
        'SELECT nested.id FROM (SELECT id FROM orders) AS nested',
        'SELECT id FROM orders UNION SELECT id FROM archived_orders',
    ];
    for (const sql of allowed) {
        const result = await service.validateSelect(sql);
        strict_1.default.match(result.executableSql, /LIMIT 1001;$/);
    }
});
(0, node_test_1.default)('4: multiple statements are rejected even when every statement is SELECT', async () => {
    await assertSafetyError('SELECT 1; SELECT 2;', 'NOT_ALLOWED', 'Exactly one SELECT');
});
(0, node_test_1.default)('5: INSERT is rejected by AST statement type', async () => {
    await assertSafetyError('INSERT INTO orders(id) VALUES (1)', 'NOT_ALLOWED', 'Only a SELECT');
});
(0, node_test_1.default)('6: UPDATE is rejected by AST statement type', async () => {
    await assertSafetyError('UPDATE orders SET status = \'DONE\'', 'NOT_ALLOWED', 'Only a SELECT');
});
(0, node_test_1.default)('7: DELETE is rejected by AST statement type', async () => {
    await assertSafetyError('DELETE FROM orders', 'NOT_ALLOWED', 'Only a SELECT');
});
(0, node_test_1.default)('8: a data-modifying CTE is rejected', async () => {
    await assertSafetyError('WITH removed AS (DELETE FROM orders RETURNING id) SELECT id FROM removed', 'NOT_ALLOWED', 'Data-modifying CTEs');
});
(0, node_test_1.default)('9: SELECT INTO is rejected', async () => {
    await assertSafetyError('SELECT id INTO temporary_orders FROM orders', 'NOT_ALLOWED', 'SELECT INTO');
});
(0, node_test_1.default)('10: FOR UPDATE and FOR SHARE locking clauses are rejected', async () => {
    await assertSafetyError('SELECT * FROM orders FOR UPDATE', 'NOT_ALLOWED', 'locking clauses');
    await assertSafetyError('SELECT * FROM orders FOR SHARE', 'NOT_ALLOWED', 'locking clauses');
});
(0, node_test_1.default)('11: DDL, CALL, DO, COPY, transaction, and utility statements are rejected', async () => {
    const forbidden = [
        'CREATE TABLE forbidden(id integer)',
        'ALTER TABLE orders ADD COLUMN forbidden integer',
        'DROP TABLE orders',
        'MERGE INTO orders o USING updates u ON o.id = u.id WHEN MATCHED THEN UPDATE SET status = u.status',
        'CALL support_procedure()',
        'DO $$ BEGIN RAISE NOTICE \'no\'; END $$',
        'COPY orders TO STDOUT',
        'BEGIN',
        'EXPLAIN SELECT 1',
    ];
    for (const sql of forbidden) {
        await assertSafetyError(sql, 'NOT_ALLOWED', 'Only a SELECT');
    }
});
(0, node_test_1.default)('empty SQL and PostgreSQL syntax errors are rejected safely', async () => {
    await assertSafetyError('   ', 'NOT_ALLOWED', 'Enter a SELECT');
    await strict_1.default.rejects(() => service.validateSelect('SELECT FROM'), (error) => error instanceof sqlSafetyService_1.SqlSafetyError
        && error.details.kind === 'SYNTAX'
        && error.details.sqlState === '42601'
        && typeof error.details.position === 'number'
        && !('stack' in error.details));
});
async function assertSafetyError(sql, kind, messageFragment) {
    await strict_1.default.rejects(() => service.validateSelect(sql), (error) => error instanceof sqlSafetyService_1.SqlSafetyError
        && error.details.kind === kind
        && error.details.message.includes(messageFragment));
}
