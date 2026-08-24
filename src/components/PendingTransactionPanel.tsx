import { useEffect, useState } from 'react';
import type { PendingMutationTransaction } from '../../shared/mutationTransaction';
import { getPendingTransactionSummary } from '../pendingTransactionUi';

interface PendingTransactionPanelProps {
  transaction: PendingMutationTransaction;
  busyAction?: 'COMMIT' | 'ROLLBACK';
  error?: string;
  onCommit: () => void;
  onRollback: () => void;
}

export function PendingTransactionPanel({
  transaction,
  busyAction,
  error,
  onCommit,
  onRollback,
}: PendingTransactionPanelProps) {
  const [nowMs, setNowMs] = useState(Date.now);
  const production = transaction.connection.environment === 'PROD';
  const summary = getPendingTransactionSummary(transaction, nowMs);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [transaction.transactionId]);

  return (
    <div className={`pending-transaction-panel compact ${production ? 'production' : ''}`} role="alert">
      {production && <div className="pending-production-badge">PRODUCTION DATABASE</div>}
      <div className="pending-transaction-row">
        <div className="pending-transaction-title">
          <span>!</span>
          <div><strong>НЕЗАФИКСИРОВАННАЯ ТРАНЗАКЦИЯ</strong><small>Изменения ожидают решения</small></div>
        </div>
        <dl>
          <div><dt>Операция</dt><dd>{summary.operation}</dd></div>
          <div><dt>Таблица</dt><dd>{summary.table}</dd></div>
          <div><dt>Строк</dt><dd>{summary.affectedRows}</dd></div>
          <div className="rollback-countdown"><dt>Автооткат</dt><dd>{formatCountdown(summary.remainingSeconds)}</dd></div>
        </dl>
        <div className="pending-transaction-actions">
          <button type="button" className="rollback-action" disabled={Boolean(busyAction)} onClick={onRollback}>{busyAction === 'ROLLBACK' ? 'Откат…' : 'Откатить'}</button>
          <button type="button" className="commit-action" disabled={Boolean(busyAction)} onClick={onCommit}>{busyAction === 'COMMIT' ? 'Фиксация…' : 'Зафиксировать'}</button>
        </div>
      </div>
      {transaction.storageWarnings?.map((warning) => <div className="storage-warning" key={warning}>{warning}</div>)}
      {error && <div className="data-message error" role="alert">{error}</div>}
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}
