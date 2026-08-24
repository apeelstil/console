import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import {
  MutationSafetyError,
  MutationSafetyService,
} from '../electron/postgres/mutationSafetyService';

const service = new MutationSafetyService();
before(() => service.initialize());

test('1: INSERT VALUES and INSERT SELECT are allowed with an explicit schema target', async () => {
  const values = await service.validateMutation(
    "INSERT INTO public.orders(id, status) VALUES (1, 'NEW')",
  );
  const select = await service.validateMutation(
    'INSERT INTO archive.orders(id) SELECT id FROM public.orders WHERE archived = TRUE',
  );

  assert.equal(values.operation, 'INSERT');
  assert.deepEqual(values.target, { schema: 'public', table: 'orders' });
  assert.match(values.normalizedSql, /^INSERT INTO public\.orders/);
  assert.equal(select.operation, 'INSERT');
  assert.deepEqual(select.target, { schema: 'archive', table: 'orders' });
});

test('2: UPDATE with WHERE is allowed', async () => {
  const result = await service.validateMutation(
    "UPDATE public.orders SET status = 'DONE' WHERE id = 7",
  );
  assert.equal(result.operation, 'UPDATE');
  assert.deepEqual(result.target, { schema: 'public', table: 'orders' });
  assert.match(result.normalizedSql, /WHERE id = 7$/);
});

test('3: UPDATE without WHERE is blocked', async () => {
  await assertBlocked("UPDATE public.orders SET status = 'DONE'", 'UPDATE requires a WHERE');
});

test('4: DELETE, MERGE, DDL, utility, and transaction commands are blocked', async () => {
  for (const sql of [
    'DELETE FROM public.orders WHERE id = 1',
    'MERGE INTO public.orders o USING public.updates u ON o.id = u.id WHEN MATCHED THEN UPDATE SET status = u.status',
    'TRUNCATE public.orders',
    'CREATE TABLE public.forbidden(id integer)',
    'CALL public.refresh_orders()',
    "DO $$ BEGIN RAISE NOTICE 'no'; END $$",
    'COPY public.orders TO STDOUT',
    'BEGIN',
    'COMMIT',
  ]) {
    await assertBlocked(sql, 'Only INSERT or UPDATE');
  }
});

test('5: multiple statements are blocked', async () => {
  await assertBlocked(
    'INSERT INTO public.orders(id) VALUES (1); UPDATE public.orders SET id = 2 WHERE id = 1;',
    'Exactly one INSERT or UPDATE',
  );
});

test('6: a data-modifying CTE is blocked', async () => {
  await assertBlocked(
    'WITH changed AS (UPDATE public.orders SET status = \'X\' WHERE id = 1 RETURNING id) INSERT INTO public.audit_ids(id) SELECT id FROM changed',
    'Data-modifying CTEs',
  );
});

test('7: RETURNING is blocked for INSERT and UPDATE', async () => {
  await assertBlocked('INSERT INTO public.orders(id) VALUES (1) RETURNING id', 'RETURNING');
  await assertBlocked('UPDATE public.orders SET status = \'X\' WHERE id = 1 RETURNING id', 'RETURNING');
});

test('8: ON CONFLICT DO UPDATE is blocked while DO NOTHING remains allowed', async () => {
  await assertBlocked(
    'INSERT INTO public.orders(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id',
    'ON CONFLICT DO UPDATE',
  );
  const allowed = await service.validateMutation(
    'INSERT INTO public.orders(id) VALUES (1) ON CONFLICT DO NOTHING',
  );
  assert.equal(allowed.operation, 'INSERT');
});

test('9: system schema and unqualified mutation targets are blocked', async () => {
  for (const sql of [
    'INSERT INTO pg_catalog.pg_class(relname) VALUES (\'x\')',
    'UPDATE information_schema.tables SET table_name = \'x\' WHERE table_name = \'y\'',
    'INSERT INTO pg_temp_3.items(id) VALUES (1)',
  ]) {
    await assertBlocked(sql, 'system schemas');
  }
  await assertBlocked('INSERT INTO orders(id) VALUES (1)', 'explicit schema-qualified');
  await assertBlocked('UPDATE orders SET status = \'X\' WHERE id = 1', 'explicit schema-qualified');
});

async function assertBlocked(sql: string, messageFragment: string): Promise<void> {
  await assert.rejects(
    () => service.validateMutation(sql),
    (error: unknown) => error instanceof MutationSafetyError
      && error.details.message.includes(messageFragment),
  );
}
