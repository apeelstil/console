import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  getPasswordInputType,
  nextPasswordRevealState,
} from '../src/passwordReveal';
import { getPendingTransactionSummary } from '../src/pendingTransactionUi';
import { MUTATION_CONFIRMATION_TIMEOUT_MS, type PendingMutationTransaction } from '../shared/mutationTransaction';
import { USER_MESSAGES } from '../shared/userMessages';

test('password is hidden by default and an ordinary click cannot latch visibility', () => {
  assert.equal(getPasswordInputType(false), 'password');
  assert.equal(nextPasswordRevealState(false, { type: 'click' }), false);
});

test('pointer hold reveals the password only while pressed', () => {
  assert.equal(nextPasswordRevealState(false, { type: 'pointerdown' }), true);
});

test('pointerup hides a revealed password', () => {
  assert.equal(nextPasswordRevealState(true, { type: 'pointerup' }), false);
});

test('pointerleave, pointercancel, and blur immediately hide the password', () => {
  for (const type of ['pointerleave', 'pointercancel', 'blur'] as const) {
    assert.equal(nextPasswordRevealState(true, { type }), false);
  }
});

test('Space and Enter reveal only between keydown and keyup', () => {
  for (const key of [' ', 'Enter']) {
    const held = nextPasswordRevealState(false, { type: 'keydown', key });
    assert.equal(held, true);
    assert.equal(nextPasswordRevealState(held, { type: 'keyup', key }), false);
  }
  assert.equal(nextPasswordRevealState(false, { type: 'keydown', key: 'Escape' }), false);
});

test('password reveal is renderer-only and does not alter credential storage', () => {
  const revealSource = source('src/passwordReveal.ts');
  const credentialSource = source('electron/storage/credentialStorage.ts');

  assert.doesNotMatch(revealSource, /clipboard|localStorage|sessionStorage|ipcRenderer|safeStorage/i);
  assert.match(credentialSource, /safeStorage\.encryptString/);
  assert.match(credentialSource, /safeStorage\.decryptString/);
});

test('the connection password field wires accessible pointer and keyboard hold events', () => {
  const inputSource = source('src/components/PasswordInput.tsx');
  const dialogSource = source('src/components/ConnectionDialog.tsx');

  for (const handler of [
    'onPointerDown', 'onPointerUp', 'onPointerLeave', 'onPointerCancel',
    'onBlur', 'onKeyDown', 'onKeyUp',
  ]) {
    assert.match(inputSource, new RegExp(handler));
  }
  assert.match(inputSource, /Показать пароль, пока кнопка удерживается/);
  assert.match(dialogSource, /<PasswordInput/);
  assert.doesNotMatch(dialogSource, /type="password"/);
});

test('key connection, safety, cancellation, and timeout messages are Russian', () => {
  assert.equal(USER_MESSAGES.connectionSuccessful, 'Подключение успешно');
  assert.equal(USER_MESSAGES.authenticationFailed, 'Ошибка авторизации. Проверьте логин и пароль.');
  assert.equal(USER_MESSAGES.statementNotAllowed, 'Запрос запрещён');
  assert.equal(USER_MESSAGES.updateRequiresWhere, 'UPDATE без условия WHERE запрещён.');
  assert.equal(USER_MESSAGES.queryCancelled, 'Запрос отменён');
  assert.equal(USER_MESSAGES.queryTimedOut, 'Превышено время выполнения запроса');
});

test('technical SQL keywords and SQLSTATE remain unchanged', () => {
  assert.match(USER_MESSAGES.updateRequiresWhere, /UPDATE/);
  assert.match(USER_MESSAGES.updateRequiresWhere, /WHERE/);
  assert.match(source('src/App.tsx'), /SQLSTATE \{execution\.error\.sqlState\}/);
});

test('compact pending summary exposes operation, table, affected rows, and countdown', () => {
  const transaction = pendingTransaction();
  const summary = getPendingTransactionSummary(
    transaction,
    Date.parse(transaction.startedAt) + 30_500,
  );

  assert.equal(summary.operation, 'UPDATE');
  assert.equal(summary.table, 'support.tickets');
  assert.equal(summary.affectedRows, 7);
  assert.equal(summary.remainingSeconds, 90);
  assert.equal(summary.transactionId, transaction.transactionId);
});

test('pending transaction component uses Russian action labels and stays compact', () => {
  const panelSource = source('src/components/PendingTransactionPanel.tsx');

  assert.match(panelSource, /pending-transaction-panel compact/);
  assert.match(panelSource, /summary\.operation/);
  assert.match(panelSource, /summary\.table/);
  assert.match(panelSource, /summary\.affectedRows/);
  assert.match(panelSource, /summary\.remainingSeconds/);
  assert.match(panelSource, /rollback-action[\s\S]*'Откатить'/);
  assert.match(panelSource, /commit-action[\s\S]*'Зафиксировать'/);
  assert.doesNotMatch(panelSource, /\?\s*'[^']*'\s*:\s*'ROLLBACK'/);
  assert.doesNotMatch(panelSource, /\?\s*'[^']*'\s*:\s*'COMMIT'/);
  assert.doesNotMatch(panelSource, /transaction\.sqlText/);
});

test('pending transaction action labels call the existing rollback and commit handlers', () => {
  const panelSource = source('src/components/PendingTransactionPanel.tsx');

  assert.match(panelSource, /className="rollback-action"[\s\S]*onClick=\{onRollback\}/);
  assert.match(panelSource, /className="commit-action"[\s\S]*onClick=\{onCommit\}/);
});

test('COMMIT and ROLLBACK continue to use the current transaction ID', () => {
  const appSource = source('src/App.tsx');
  const managerSource = source('electron/postgres/mutationTransactionManager.ts');
  assert.match(appSource, /commitMutation\(mutationState\.transactionId\)/);
  assert.match(appSource, /rollbackMutation\(mutationState\.transactionId\)/);
  assert.match(managerSource, /const COMMIT_SQL = 'COMMIT;'/);
  assert.match(managerSource, /const ROLLBACK_SQL = 'ROLLBACK;'/);
  assert.match(managerSource, /transactionEvent\(pending, 'COMMIT', 'COMMITTED'\)/);
  assert.match(managerSource, /transactionEvent\(pending, 'ROLLBACK', outcome\)/);
});

test('pending action colors cover normal, hover, focus, and disabled states', () => {
  const styles = source('src/styles.css');

  assert.match(styles, /\.rollback-action \{[\s\S]*background: #b4232f/);
  assert.match(styles, /\.commit-action \{[\s\S]*background: #16814c/);
  assert.match(styles, /\.rollback-action:hover:not\(:disabled\)/);
  assert.match(styles, /\.commit-action:hover:not\(:disabled\)/);
  assert.match(styles, /\.rollback-action:focus-visible/);
  assert.match(styles, /\.commit-action:focus-visible/);
  assert.match(styles, /\.rollback-action:disabled/);
  assert.match(styles, /\.commit-action:disabled/);
});

test('compact UI keeps the existing 120 second automatic rollback contract', () => {
  assert.equal(MUTATION_CONFIRMATION_TIMEOUT_MS, 120_000);
  assert.match(source('electron/postgres/mutationTransactionManager.ts'), /MUTATION_CONFIRMATION_TIMEOUT_MS/);
});

test('BrowserWindow is created before deferred SQL services while local persistence stays initialized first', () => {
  const mainSource = source('electron/main.ts');
  const databaseIndex = mainSource.indexOf('initializeDatabase(databasePath)');
  const windowIndex = mainSource.indexOf('createWindow();');
  const deferredIndex = mainSource.indexOf('void initializeDeferredSqlServices()');

  assert.ok(databaseIndex >= 0);
  assert.ok(windowIndex > databaseIndex);
  assert.ok(deferredIndex > windowIndex);
  assert.match(source('tests/localQueryData.test.ts'), /survive a database restart/);
});

function source(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function pendingTransaction(): PendingMutationTransaction {
  return {
    status: 'PENDING_CONFIRMATION',
    transactionId: '00000000-0000-4000-8000-000000000001',
    operation: 'UPDATE',
    target: { schema: 'support', table: 'tickets' },
    affectedRows: 7,
    startedAt: '2026-08-24T10:00:00.000Z',
    rollbackDeadlineAt: '2026-08-24T10:02:00.000Z',
    connection: {
      name: 'Local TEST',
      host: 'localhost',
      port: 5432,
      database: 'supra_test',
      username: 'support_user',
      environment: 'TEST',
    },
  };
}
