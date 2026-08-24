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
      if (!result) return setError('Query history is unavailable.');
      if (!result.ok) return setError(result.error);
      setEntries(result.data);
      setSelected((current) => result.data.find((entry) => entry.id === current?.id) ?? result.data[0]);
      setError(undefined);
    } catch {
      setError('Could not load query history.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(window.supraDesktop).then(async (api) => {
      if (!api) {
        if (active) setError('Query history is unavailable.');
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
      if (active) setError('Could not load query history.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <ActivitySection title="Query History" subtitle="Latest 500 Execute attempts" loading={loading} onRefresh={() => void load()}>
      <div className="activity-table-wrap">
        <table className="activity-table">
          <thead><tr><th>Time</th><th>Target</th><th>Status</th><th>SQL</th><th>Duration</th><th>Rows</th></tr></thead>
          <tbody>{entries.map((entry) => (
            <tr key={entry.id} tabIndex={0} aria-selected={selected?.id === entry.id} className={selected?.id === entry.id ? 'selected' : ''} onClick={() => setSelected(entry)} onKeyDown={(event) => selectRowFromKeyboard(event, () => setSelected(entry))}>
              <td>{formatTimestamp(entry.timestamp)}</td>
              <td>{entry.database ?? '—'}<small>{entry.profileName ?? 'Temporary connection'}</small></td>
              <td><StatusBadge status={entry.status} /></td>
              <td className="sql-preview">{previewSql(entry.sqlText)}</td>
              <td>{formatMetric(entry.durationMs, 'ms')}</td>
              <td>{entry.returnedRows ?? '—'}{entry.truncated ? '+' : ''}</td>
            </tr>
          ))}</tbody>
        </table>
        {loading && <div className="record-empty" role="status">Loading query history…</div>}
        {!loading && entries.length === 0 && !error && <div className="record-empty">No Execute attempts have been recorded.</div>}
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
      if (!result) return setError('Audit log is unavailable.');
      if (!result.ok) return setError(result.error);
      setEntries(result.data);
      setSelected((current) => result.data.find((entry) => entry.id === current?.id) ?? result.data[0]);
      setError(undefined);
    } catch {
      setError('Could not load audit log.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(window.supraDesktop).then(async (api) => {
      if (!api) {
        if (active) setError('Audit log is unavailable.');
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
      if (active) setError('Could not load audit log.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <ActivitySection title="Audit Log" subtitle="Local read-only audit · not tamper-proof" loading={loading} onRefresh={() => void load()}>
      <div className="activity-table-wrap">
        <table className="activity-table audit-table">
          <thead><tr><th>Time</th><th>Windows user</th><th>Environment / database</th><th>Operation</th><th>Outcome</th><th>Duration / rows</th></tr></thead>
          <tbody>{entries.map((entry) => (
            <tr key={entry.id} tabIndex={0} aria-selected={selected?.id === entry.id} className={selected?.id === entry.id ? 'selected' : ''} onClick={() => setSelected(entry)} onKeyDown={(event) => selectRowFromKeyboard(event, () => setSelected(entry))}>
              <td>{formatTimestamp(entry.timestamp)}</td>
              <td>{entry.windowsUser}<small>{entry.computerName}</small></td>
              <td>{entry.environment ?? '—'} / {entry.database ?? '—'}<small>{entry.profileName ?? 'Temporary connection'}</small></td>
              <td>{entry.operation}</td>
              <td><StatusBadge status={entry.outcome} /></td>
              <td>{formatMetric(entry.durationMs, 'ms')} / {entry.returnedRows ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table>
        {loading && <div className="record-empty" role="status">Loading audit log…</div>}
        {!loading && entries.length === 0 && !error && <div className="record-empty">No audit entries have been recorded.</div>}
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
        <button type="button" className="secondary" disabled={loading} onClick={onRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div className="activity-layout">{children}</div>
    </section>
  );
}

function ActivityDetail({ entry, onLoadSql }: {
  entry?: QueryHistoryEntry;
  onLoadSql: QueryHistoryViewProps['onLoadSql'];
}) {
  if (!entry) return <div className="activity-detail record-empty">Select a history entry.</div>;
  return (
    <div className="activity-detail">
      <div className="record-detail-heading"><strong>Execute details</strong><button type="button" onClick={() => onLoadSql(entry.sqlText, 'history query')}>Load in editor</button></div>
      <dl><dt>Target</dt><dd>{entry.databaseUser ?? '—'} @ {entry.host ?? '—'} / {entry.database ?? '—'}</dd><dt>Status</dt><dd>{entry.status}</dd></dl>
      <pre>{entry.sqlText}</pre>
      {entry.errorMessage && <div className="safe-error-detail">{entry.errorMessage}</div>}
    </div>
  );
}

function AuditDetail({ entry }: { entry?: AuditLogEntry }) {
  if (!entry) return <div className="activity-detail record-empty">Select an audit entry.</div>;
  return (
    <div className="activity-detail">
      <div className="record-detail-heading"><strong>Read-only audit details</strong><small>{entry.id}</small></div>
      <dl><dt>Database user</dt><dd>{entry.databaseUser ?? '—'}</dd><dt>Target</dt><dd>{entry.host ?? '—'} / {entry.database ?? '—'}</dd></dl>
      <pre>{entry.sqlText}</pre>
      {(entry.errorCode || entry.errorMessage) && <div className="safe-error-detail">{entry.errorCode && `SQLSTATE ${entry.errorCode} · `}{entry.errorMessage}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`activity-status ${status.toLowerCase().replaceAll('_', '-')}`}>{status}</span>;
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
