import type { PendingMutationTransaction } from '../../shared/mutationTransaction';

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
  return (
    <div className={`pending-transaction-panel ${transaction.connection.environment === 'PROD' ? 'production' : ''}`}>
      <div className="pending-transaction-title"><span>!</span><div><strong>UNCOMMITTED TRANSACTION</strong><small>{transaction.operation} executed inside transaction</small></div></div>
      <dl>
        <dt>Database</dt><dd>{transaction.connection.name} · {transaction.connection.database} · {transaction.connection.environment}</dd>
        <dt>Table</dt><dd>{transaction.target.schema}.{transaction.target.table}</dd>
        <dt>Affected rows</dt><dd>{transaction.affectedRows}</dd>
        <dt>Transaction ID</dt><dd>{transaction.transactionId}</dd>
      </dl>
      <p>Changes are NOT committed yet. Locks may be held until the transaction is completed.</p>
      {transaction.storageWarnings?.map((warning) => <div className="storage-warning" key={warning}>{warning}</div>)}
      {error && <div className="data-message error" role="alert">{error}</div>}
      <div className="pending-transaction-actions">
        <button type="button" className="rollback-action" disabled={Boolean(busyAction)} onClick={onRollback}>{busyAction === 'ROLLBACK' ? 'ROLLING BACK…' : 'ROLLBACK'}</button>
        <button type="button" className="commit-action" disabled={Boolean(busyAction)} onClick={onCommit}>{busyAction === 'COMMIT' ? 'COMMITTING…' : 'COMMIT'}</button>
      </div>
    </div>
  );
}
