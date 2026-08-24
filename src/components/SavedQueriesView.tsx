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
      setMessage({ kind: 'error', text: 'Хранилище сохранённых запросов недоступно.' });
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
        setMessage({ kind: 'error', text: 'Хранилище сохранённых запросов недоступно.' });
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
      if (active) setMessage({ kind: 'error', text: 'Не удалось загрузить сохранённые запросы.' });
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
      setMessage({ kind: 'success', text: 'Запрос сохранён локально.' });
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
      setMessage({ kind: 'success', text: 'Параметры сохранённого запроса обновлены.' });
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
      setMessage({ kind: 'success', text: 'Сохранённый запрос удалён.' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-section panel">
      <div className="data-section-toolbar">
        <div><strong>Сохранённые запросы</strong><small>Хранятся локально в профиле Windows</small></div>
        <button type="button" disabled={!editorSql.trim() || busy} onClick={beginCreate}>+ Сохранить текущий SQL</button>
      </div>
      <div className="data-section-body">
        <div className="record-list saved-query-list">
          {loading && <div className="record-empty" role="status">Загрузка сохранённых запросов…</div>}
          {!loading && queries.length === 0 && !creating && <div className="record-empty">Сохранённых запросов пока нет.</div>}
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
              <div className="record-detail-heading"><strong>Сохранить текущий SQL</strong><small>Символов: {editorSql.length}</small></div>
              <label>Название<input value={name} autoFocus onChange={(event) => setName(event.target.value)} /></label>
              <label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <pre>{editorSql}</pre>
              <div className="record-actions">
                <button type="button" className="secondary" onClick={() => { setCreating(false); void refresh(); }}>Отмена</button>
                <button type="button" disabled={busy || !name.trim() || !editorSql.trim()} onClick={() => void createQuery()}>Сохранить</button>
              </div>
            </>
          ) : selected ? (
            <>
              <div className="record-detail-heading"><strong>Сохранённый запрос</strong><small>Обновлён {formatTimestamp(selected.updatedAt)}</small></div>
              <label>Название<input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <pre>{selected.sqlText}</pre>
              {deletePending && (
                <div className="inline-delete-confirm">
                  <span>Удалить этот сохранённый запрос?</span>
                  <button type="button" className="secondary" onClick={() => setDeletePending(false)}>Отмена</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => void deleteQuery()}>Удалить</button>
                </div>
              )}
              <div className="record-actions">
                <button type="button" className="danger-link" onClick={() => setDeletePending(true)}>Удалить</button>
                <span />
                <button type="button" className="secondary" disabled={busy || !name.trim()} onClick={() => void updateQuery()}>Сохранить параметры</button>
                <button type="button" onClick={() => onLoadSql(selected.sqlText, 'сохранённым запросом')}>Загрузить в редактор</button>
              </div>
            </>
          ) : <div className="record-empty detail-empty">Выберите сохранённый запрос или сохраните содержимое редактора.</div>}
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
