import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SqlSafetyError,
  SqlSafetyService,
} from '../electron/postgres/sqlSafetyService';

const service = new SqlSafetyService();

test('1: an ordinary SELECT is allowed and wrapped with a server-side 1001 row cap', async () => {
  const result = await service.validateSelect('SELECT id, status FROM public.orders ORDER BY id;');

  assert.match(result.normalizedSql, /^SELECT/);
  assert.match(result.executableSql, /^SELECT \*\nFROM \(/);
  assert.match(result.executableSql, /ORDER BY/);
  assert.match(result.executableSql, /\) AS "__supra_query_result"\nLIMIT 1001;$/);
});

test('2: SELECT WITH containing a SELECT CTE is allowed', async () => {
  const result = await service.validateSelect(
    'WITH recent AS (SELECT id FROM orders WHERE created_at > CURRENT_DATE) SELECT id FROM recent',
  );

  assert.match(result.normalizedSql, /^WITH/);
  assert.match(result.executableSql, /LIMIT 1001;$/);
});

test('3: JOIN, subquery, and UNION SELECT forms are allowed', async () => {
  const allowed = [
    'SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id',
    'SELECT nested.id FROM (SELECT id FROM orders) AS nested',
    'SELECT id FROM orders UNION SELECT id FROM archived_orders',
  ];

  for (const sql of allowed) {
    const result = await service.validateSelect(sql);
    assert.match(result.executableSql, /LIMIT 1001;$/);
  }
});

test('4: multiple statements are rejected even when every statement is SELECT', async () => {
  await assertSafetyError('SELECT 1; SELECT 2;', 'NOT_ALLOWED', 'Разрешён ровно один запрос SELECT');
});

test('5: INSERT is rejected by AST statement type', async () => {
  await assertSafetyError('INSERT INTO orders(id) VALUES (1)', 'NOT_ALLOWED', 'Разрешён только запрос SELECT');
});

test('6: UPDATE is rejected by AST statement type', async () => {
  await assertSafetyError('UPDATE orders SET status = \'DONE\'', 'NOT_ALLOWED', 'Разрешён только запрос SELECT');
});

test('7: DELETE is rejected by AST statement type', async () => {
  await assertSafetyError('DELETE FROM orders', 'NOT_ALLOWED', 'Разрешён только запрос SELECT');
});

test('8: a data-modifying CTE is rejected', async () => {
  await assertSafetyError(
    'WITH removed AS (DELETE FROM orders RETURNING id) SELECT id FROM removed',
    'NOT_ALLOWED',
    'CTE, изменяющие данные',
  );
});

test('9: SELECT INTO is rejected', async () => {
  await assertSafetyError(
    'SELECT id INTO temporary_orders FROM orders',
    'NOT_ALLOWED',
    'SELECT INTO',
  );
});

test('10: FOR UPDATE and FOR SHARE locking clauses are rejected', async () => {
  await assertSafetyError('SELECT * FROM orders FOR UPDATE', 'NOT_ALLOWED', 'Блокирующие конструкции SELECT');
  await assertSafetyError('SELECT * FROM orders FOR SHARE', 'NOT_ALLOWED', 'Блокирующие конструкции SELECT');
});

test('11: DDL, CALL, DO, COPY, transaction, and utility statements are rejected', async () => {
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
    await assertSafetyError(sql, 'NOT_ALLOWED', 'Разрешён только запрос SELECT');
  }
});

test('empty SQL and PostgreSQL syntax errors are rejected safely', async () => {
  await assertSafetyError('   ', 'NOT_ALLOWED', 'Введите запрос SELECT');
  await assert.rejects(
    () => service.validateSelect('SELECT FROM'),
    (error: unknown) => error instanceof SqlSafetyError
      && error.details.kind === 'SYNTAX'
      && error.details.sqlState === '42601'
      && typeof error.details.position === 'number'
      && !('stack' in error.details),
  );
});

async function assertSafetyError(
  sql: string,
  kind: 'NOT_ALLOWED' | 'SYNTAX',
  messageFragment: string,
): Promise<void> {
  await assert.rejects(
    () => service.validateSelect(sql),
    (error: unknown) => error instanceof SqlSafetyError
      && error.details.kind === kind
      && error.details.message.includes(messageFragment),
  );
}
