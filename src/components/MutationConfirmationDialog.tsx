import type { PreparedMutation } from '../../shared/mutationTransaction';

interface MutationConfirmationDialogProps {
  preparation: PreparedMutation;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MutationConfirmationDialog({
  preparation,
  busy,
  error,
  onCancel,
  onConfirm,
}: MutationConfirmationDialogProps) {
  const production = preparation.connection.environment === 'PROD';
  return (
    <div className="modal-backdrop mutation-modal-backdrop">
      <section className={`mutation-confirmation ${production ? 'production' : ''}`} role="dialog" aria-modal="true" aria-labelledby="mutation-confirm-title">
        {production && <div className="mutation-production-warning">PRODUCTION DATABASE</div>}
        <header>
          <div>
            <h2 id="mutation-confirm-title">Confirm {preparation.operation}</h2>
            <p>This statement will execute against PostgreSQL and remain uncommitted.</p>
          </div>
          <span className={`environment-badge ${preparation.connection.environment.toLowerCase()}`}>{preparation.connection.environment}</span>
        </header>
        <dl>
          <dt>Database</dt><dd>{preparation.connection.database}</dd>
          <dt>Connection</dt><dd>{preparation.connection.name}</dd>
          <dt>Target</dt><dd>{preparation.target.schema}.{preparation.target.table}</dd>
          <dt>Operation</dt><dd>{preparation.operation}</dd>
        </dl>
        <div className="mutation-sql-label">SQL to execute</div>
        <pre>{preparation.sqlText}</pre>
        <div className="mutation-lock-notice">
          This is not a dry run. The statement can hold locks until COMMIT, ROLLBACK, or automatic rollback after 120 seconds.
        </div>
        {preparation.storageWarnings?.map((warning) => <div className="storage-warning" key={warning}>{warning}</div>)}
        {error && <div className="data-message error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={production ? 'danger' : ''} disabled={busy} onClick={onConfirm}>
            {busy ? 'Executing…' : 'Execute in transaction'}
          </button>
        </footer>
      </section>
    </div>
  );
}
