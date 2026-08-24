"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importStar(require("node:test"));
const mutationSafetyService_1 = require("../electron/postgres/mutationSafetyService");
const service = new mutationSafetyService_1.MutationSafetyService();
(0, node_test_1.before)(() => service.initialize());
(0, node_test_1.default)('1: INSERT VALUES and INSERT SELECT are allowed with an explicit schema target', async () => {
    const values = await service.validateMutation("INSERT INTO public.orders(id, status) VALUES (1, 'NEW')");
    const select = await service.validateMutation('INSERT INTO archive.orders(id) SELECT id FROM public.orders WHERE archived = TRUE');
    strict_1.default.equal(values.operation, 'INSERT');
    strict_1.default.deepEqual(values.target, { schema: 'public', table: 'orders' });
    strict_1.default.match(values.normalizedSql, /^INSERT INTO public\.orders/);
    strict_1.default.equal(select.operation, 'INSERT');
    strict_1.default.deepEqual(select.target, { schema: 'archive', table: 'orders' });
});
(0, node_test_1.default)('2: UPDATE with WHERE is allowed', async () => {
    const result = await service.validateMutation("UPDATE public.orders SET status = 'DONE' WHERE id = 7");
    strict_1.default.equal(result.operation, 'UPDATE');
    strict_1.default.deepEqual(result.target, { schema: 'public', table: 'orders' });
    strict_1.default.match(result.normalizedSql, /WHERE id = 7$/);
});
(0, node_test_1.default)('3: UPDATE without WHERE is blocked', async () => {
    await assertBlocked("UPDATE public.orders SET status = 'DONE'", 'UPDATE requires a WHERE');
});
(0, node_test_1.default)('4: DELETE, MERGE, DDL, utility, and transaction commands are blocked', async () => {
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
(0, node_test_1.default)('5: multiple statements are blocked', async () => {
    await assertBlocked('INSERT INTO public.orders(id) VALUES (1); UPDATE public.orders SET id = 2 WHERE id = 1;', 'Exactly one INSERT or UPDATE');
});
(0, node_test_1.default)('6: a data-modifying CTE is blocked', async () => {
    await assertBlocked('WITH changed AS (UPDATE public.orders SET status = \'X\' WHERE id = 1 RETURNING id) INSERT INTO public.audit_ids(id) SELECT id FROM changed', 'Data-modifying CTEs');
});
(0, node_test_1.default)('7: RETURNING is blocked for INSERT and UPDATE', async () => {
    await assertBlocked('INSERT INTO public.orders(id) VALUES (1) RETURNING id', 'RETURNING');
    await assertBlocked('UPDATE public.orders SET status = \'X\' WHERE id = 1 RETURNING id', 'RETURNING');
});
(0, node_test_1.default)('8: ON CONFLICT DO UPDATE is blocked while DO NOTHING remains allowed', async () => {
    await assertBlocked('INSERT INTO public.orders(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id', 'ON CONFLICT DO UPDATE');
    const allowed = await service.validateMutation('INSERT INTO public.orders(id) VALUES (1) ON CONFLICT DO NOTHING');
    strict_1.default.equal(allowed.operation, 'INSERT');
});
(0, node_test_1.default)('9: system schema and unqualified mutation targets are blocked', async () => {
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
async function assertBlocked(sql, messageFragment) {
    await strict_1.default.rejects(() => service.validateMutation(sql), (error) => error instanceof mutationSafetyService_1.MutationSafetyError
        && error.details.message.includes(messageFragment));
}
