import { useCallback, useEffect, useState } from 'react';
import type { AuditLogEntry, QueryHistoryEntry } from '../../shared/localQueryData';

interface QueryHistoryViewProps {
  onLoadSql: (sql: string, sourceLabel: string) => void;
}

export function QueryHistoryView({ onLoadSql }: QueryHistoryViewProps) {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([]);
  const [selected, setSelected] = useState<QueryHistoryEntry>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.supraDesktop?.listQueryHistory();
      if (!result) return setError('История запросов недоступна.');
      if (!result.ok) return setError(result.error);
      setEntries(result.data);
      setSelected((current) => result.data.find((entry) => entry.id === current?.id) ?? result.data[0]);
      setError(undefined);
    } catch {
      setError('Не удалось загрузить историю запросов.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(window.supraDesktop).then(async (api) => {
      if (!api) {
        if (active) setError('История запросов недоступна.');
        return;
      }
      const result = await api.listQueryHistory();
      if (!active) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEntries(result.data);
      setSelected(result.data[0]);
      setError(undefined);
    }).catch(() => {
      if (active) setError('Не удалось загрузить историю запросов.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <ActivitySection title="История запросов" subtitle="Последние 500 попыток выполнения" loading={loading} onRefresh={() => void load()}>
      <div className="activity-table-wrap">
        <table className="activity-table">
          <thead><tr><th>Время</th><th>Подключение</th><th>Статус</th><th>SQL</th><th>Длительность</th><th>Строки</th></tr></thead>
          <tbody>{entries.map((entry) => (
            <tr key={entry.id} tabIndex={0} aria-selected={selected?.id === entry.id} className={selected?.id === entry.id ? 'selected' : ''} onClick={() => setSelected(entry)} onKeyDown={(event) => selectRowFromKeyboard(event, () => setSelected(entry))}>
              <td>{formatTimestamp(entry.timestamp)}</td>
              <td>{entry.database ?? '—'}<small>{entry.profileName ?? 'Временное подключение'}</small></td>
              <td><StatusBadge status={entry.status} /></td>
              <td className="sql-preview">{previewSql(entry.sqlText)}</td>
              <td>{formatMetric(entry.durationMs, 'мс')}</td>
              <td>{entry.returnedRows ?? '—'}{entry.truncated ? '+' : ''}</td>
            </tr>
          ))}</tbody>
        </table>
        {loading && <div className="record-empty" role="status">Загрузка истории запросов…</div>}
        {!loading && entries.length === 0 && !error && <div className="record-empty">Попытки выполнения ещё не записаны.</div>}
      </div>
      <ActivityDetail entry={selected} onLoadSql={onLoadSql} />
      {error && <div className="data-message error" role="alert">{error}</div>}
    </ActivitySection>
  );
}

export function AuditLogView() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [selected, setSelected] = useState<AuditLogEntry>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.supraDesktop?.listAuditLog();
      if (!result) return setError('Журнал аудита недоступен.');
      if (!result.ok) return setError(result.error);
      setEntries(result.data);
      setSelected((current) => result.data.find((entry) => entry.id === current?.id) ?? result.data[0]);
      setError(undefined);
    } catch {
      setError('Не удалось загрузить журнал аудита.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(window.supraDesktop).then(async (api) => {
      if (!api) {
        if (active) setError('Журнал аудита недоступен.');
        return;
      }
      const result = await api.listAuditLog();
      if (!active) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEntries(result.data);
      setSelected(result.data[0]);
      setError(undefined);
    }).catch(() => {
      if (active) setError('Не удалось загрузить журнал аудита.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <ActivitySection title="Журнал аудита" subtitle="Локальный журнал только для чтения · не защищён от изменения файлов" loading={loading} onRefresh={() => void load()}>
      <div className="activity-table-wrap">
        <table className="activity-table audit-table">
          <thead><tr><th>Время</th><th>Пользователь Windows</th><th>Среда / база</th><th>Операция</th><th>Результат</th><th>Время / строки</th></tr></thead>
          <tbody>{entries.map((entry) => (
            <tr key={entry.id} tabIndex={0} aria-selected={selected?.id === entry.id} className={selected?.id === entry.id ? 'selected' : ''} onClick={() => setSelected(entry)} onKeyDown={(event) => selectRowFromKeyboard(event, () => setSelected(entry))}>
              <td>{formatTimestamp(entry.timestamp)}</td>
              <td>{entry.windowsUser}<small>{entry.computerName}</small></td>
              <td>{entry.environment ?? '—'} / {entry.database ?? '—'}<small>{entry.profileName ?? 'Временное подключение'}</small></td>
              <td>{entry.operation}</td>
              <td><StatusBadge status={entry.outcome} /></td>
              <td>{formatMetric(entry.durationMs, 'мс')} / {entry.returnedRows ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table>
        {loading && <div className="record-empty" role="status">Загрузка журнала аудита…</div>}
        {!loading && entries.length === 0 && !error && <div className="record-empty">Записей аудита пока нет.</div>}
      </div>
      <AuditDetail entry={selected} />
      {error && <div className="data-message error" role="alert">{error}</div>}
    </ActivitySection>
  );
}

function ActivitySection({ title, subtitle, loading, onRefresh, children }: {
  title: string;
  subtitle: string;
  loading: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="data-section activity-section panel">
      <div className="data-section-toolbar">
        <div><strong>{title}</strong><small>{subtitle}</small></div>
        <button type="button" className="secondary" disabled={loading} onClick={onRefresh}>{loading ? 'Обновление…' : 'Обновить'}</button>
      </div>
      <div className="activity-layout">{children}</div>
    </section>
  );
}

function ActivityDetail({ entry, onLoadSql }: {
  entry?: QueryHistoryEntry;
  onLoadSql: QueryHistoryViewProps['onLoadSql'];
}) {
  if (!entry) return <div className="activity-detail record-empty">Выберите запись истории.</div>;
  return (
    <div className="activity-detail">
      <div className="record-detail-heading"><strong>Детали выполнения</strong><button type="button" onClick={() => onLoadSql(entry.sqlText, 'запросом из истории')}>Загрузить в редактор</button></div>
      <dl><dt>Подключение</dt><dd>{entry.databaseUser ?? '—'} @ {entry.host ?? '—'} / {entry.database ?? '—'}</dd><dt>Статус</dt><dd>{formatStatus(entry.status)}</dd></dl>
      <pre>{entry.sqlText}</pre>
      {entry.errorMessage && <div className="safe-error-detail">{entry.errorMessage}</div>}
    </div>
  );
}

function AuditDetail({ entry }: { entry?: AuditLogEntry }) {
  if (!entry) return <div className="activity-detail record-empty">Выберите запись аудита.</div>;
  return (
    <div className="activity-detail">
      <div className="record-detail-heading"><strong>Детали аудита · только чтение</strong><small>{entry.id}</small></div>
      <dl><dt>Пользователь БД</dt><dd>{entry.databaseUser ?? '—'}</dd><dt>Подключение</dt><dd>{entry.host ?? '—'} / {entry.database ?? '—'}</dd></dl>
      <pre>{entry.sqlText}</pre>
      {(entry.errorCode || entry.errorMessage) && <div className="safe-error-detail">{entry.errorCode && `SQLSTATE ${entry.errorCode} · `}{entry.errorMessage}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`activity-status ${status.toLowerCase().replaceAll('_', '-')}`}>{formatStatus(status)}</span>;
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    SUCCESS: 'УСПЕШНО',
    ERROR: 'ОШИБКА',
    BLOCKED: 'ЗАБЛОКИРОВАНО',
    TIMEOUT: 'ТАЙМ-АУТ',
    CANCELLED: 'ОТМЕНЕНО',
    VALIDATED: 'ПРОВЕРЕНО',
    PENDING: 'ОЖИДАНИЕ',
    COMMITTED: 'ЗАФИКСИРОВАНО',
    ROLLED_BACK: 'ОТКАТ',
    AUTO_ROLLED_BACK: 'АВТООТКАТ',
    CONNECTION_LOST: 'СВЯЗЬ ПОТЕРЯНА',
  };
  return labels[status] ?? status;
}

function previewSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function formatMetric(value: number | null, unit: string): string {
  return value === null ? '—' : `${value} ${unit}`;
}

function selectRowFromKeyboard(event: React.KeyboardEvent<HTMLTableRowElement>, select: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  select();
}
