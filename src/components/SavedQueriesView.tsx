import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SavedQuery } from '../../shared/localQueryData';

interface SavedQueriesViewProps {
  editorSql: string;
  refreshVersion: number;
  onLoadSql: (sql: string, sourceLabel: string) => void;
}

export function SavedQueriesView({ editorSql, refreshVersion, onLoadSql }: SavedQueriesViewProps) {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string }>();

  const selected = useMemo(
    () => queries.find((query) => query.id === selectedId),
    [queries, selectedId],
  );

  const refresh = useCallback(async (preferredId?: string) => {
    const api = window.supraDesktop;
    if (!api) {
      setMessage({ kind: 'error', text: 'Saved query storage is unavailable.' });
      return;
    }
    const result = await api.listSavedQueries();
    if (!result.ok) {
      setMessage({ kind: 'error', text: result.error });
      return;
    }
    setQueries(result.data);
    const nextId = preferredId ?? selectedId;
    const nextQuery = result.data.find((query) => query.id === nextId) ?? result.data[0];
    setSelectedId(nextQuery?.id);
    setName(nextQuery?.name ?? '');
    setDescription(nextQuery?.description ?? '');
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    const api = window.supraDesktop;
    if (!api) {
      void Promise.resolve().then(() => {
        if (!active) return;
        setMessage({ kind: 'error', text: 'Saved query storage is unavailable.' });
        setLoading(false);
      });
      return () => { active = false; };
    }
    void api.listSavedQueries().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setQueries(result.data);
      const first = result.data[0];
      setSelectedId(first?.id);
      setName(first?.name ?? '');
      setDescription(first?.description ?? '');
    }).catch(() => {
      if (active) setMessage({ kind: 'error', text: 'Could not load saved queries.' });
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refreshVersion]);

  const beginCreate = () => {
    setCreating(true);
    setSelectedId(undefined);
    setName('');
    setDescription('');
    setDeletePending(false);
    setMessage(undefined);
  };

  const createQuery = async () => {
    const api = window.supraDesktop;
    if (!api || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.createSavedQuery({ name, description, sqlText: editorSql });
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setCreating(false);
      setMessage({ kind: 'success', text: 'Query saved locally.' });
      await refresh(result.data.id);
    } finally {
      setBusy(false);
    }
  };

  const updateQuery = async () => {
    const api = window.supraDesktop;
    if (!api || !selected || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.updateSavedQuery({
        id: selected.id,
        name,
        description,
        sqlText: selected.sqlText,
      });
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setMessage({ kind: 'success', text: 'Saved query details updated.' });
      await refresh(result.data.id);
    } finally {
      setBusy(false);
    }
  };

  const deleteQuery = async () => {
    const api = window.supraDesktop;
    if (!api || !selected || busy) return;
    setBusy(true);
    try {
      const result = await api.deleteSavedQuery(selected.id);
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setSelectedId(undefined);
      setDeletePending(false);
      setMessage({ kind: 'success', text: 'Saved query deleted.' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-section panel">
      <div className="data-section-toolbar">
        <div><strong>Saved Queries</strong><small>Stored locally in this Windows profile</small></div>
        <button type="button" disabled={!editorSql.trim() || busy} onClick={beginCreate}>+ Save current SQL</button>
      </div>
      <div className="data-section-body">
        <div className="record-list saved-query-list">
          {loading && <div className="record-empty" role="status">Loading saved queries…</div>}
          {!loading && queries.length === 0 && !creating && <div className="record-empty">No saved queries yet.</div>}
          {queries.map((query) => (
            <button
              type="button"
              key={query.id}
              className={selectedId === query.id ? 'record-row selected' : 'record-row'}
              onClick={() => {
                setCreating(false);
                setSelectedId(query.id);
                setName(query.name);
                setDescription(query.description ?? '');
                setDeletePending(false);
                setMessage(undefined);
              }}
            >
              <strong>{query.name}</strong>
              <span>{previewSql(query.sqlText)}</span>
              <small>{formatTimestamp(query.updatedAt)}</small>
            </button>
          ))}
        </div>
        <div className="record-detail">
          {creating ? (
            <>
              <div className="record-detail-heading"><strong>Save current SQL</strong><small>{editorSql.length} characters</small></div>
              <label>Name<input value={name} autoFocus onChange={(event) => setName(event.target.value)} /></label>
              <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <pre>{editorSql}</pre>
              <div className="record-actions">
                <button type="button" className="secondary" onClick={() => { setCreating(false); void refresh(); }}>Cancel</button>
                <button type="button" disabled={busy || !name.trim() || !editorSql.trim()} onClick={() => void createQuery()}>Save</button>
              </div>
            </>
          ) : selected ? (
            <>
              <div className="record-detail-heading"><strong>Saved query</strong><small>Updated {formatTimestamp(selected.updatedAt)}</small></div>
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <pre>{selected.sqlText}</pre>
              {deletePending && (
                <div className="inline-delete-confirm">
                  <span>Delete this saved query?</span>
                  <button type="button" className="secondary" onClick={() => setDeletePending(false)}>Cancel</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => void deleteQuery()}>Delete</button>
                </div>
              )}
              <div className="record-actions">
                <button type="button" className="danger-link" onClick={() => setDeletePending(true)}>Delete</button>
                <span />
                <button type="button" className="secondary" disabled={busy || !name.trim()} onClick={() => void updateQuery()}>Save details</button>
                <button type="button" onClick={() => onLoadSql(selected.sqlText, 'saved query')}>Load in editor</button>
              </div>
            </>
          ) : <div className="record-empty detail-empty">Select a saved query or save the current editor contents.</div>}
          {message && <div className={`data-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
        </div>
      </div>
    </section>
  );
}

function previewSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 110);
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}
