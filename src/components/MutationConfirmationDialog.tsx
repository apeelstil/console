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
            <h2 id="mutation-confirm-title">Подтверждение {preparation.operation}</h2>
            <p>Оператор будет выполнен в PostgreSQL и останется незафиксированным.</p>
          </div>
          <span className={`environment-badge ${preparation.connection.environment.toLowerCase()}`}>{preparation.connection.environment}</span>
        </header>
        <dl>
          <dt>База данных</dt><dd>{preparation.connection.database}</dd>
          <dt>Подключение</dt><dd>{preparation.connection.name}</dd>
          <dt>Таблица</dt><dd>{preparation.target.schema}.{preparation.target.table}</dd>
          <dt>Операция</dt><dd>{preparation.operation}</dd>
        </dl>
        <div className="mutation-sql-label">SQL для выполнения</div>
        <pre>{preparation.sqlText}</pre>
        <div className="mutation-lock-notice">
          Это реальное выполнение. Оператор может удерживать блокировки до COMMIT, ROLLBACK или автоматического отката через 120 секунд.
        </div>
        {preparation.storageWarnings?.map((warning) => <div className="storage-warning" key={warning}>{warning}</div>)}
        {error && <div className="data-message error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Отмена</button>
          <button type="button" className={production ? 'danger' : ''} disabled={busy} onClick={onConfirm}>
            {busy ? 'Выполнение…' : 'Выполнить в транзакции'}
          </button>
        </footer>
      </section>
    </div>
  );
}
