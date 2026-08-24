import { useState, type FormEvent } from 'react';
import type { SavedQuery } from '../../shared/localQueryData';
import { saveEditorQuery } from '../savedQueryUi';

interface SaveQueryDialogProps {
  sqlText: string;
  onCancel: () => void;
  onSaved: (query: SavedQuery) => void;
}

export function SaveQueryDialog({ sqlText, onCancel, onSaved }: SaveQueryDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const api = window.supraDesktop;
    if (!api) {
      setError('Saved query storage is unavailable.');
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const result = await saveEditorQuery(
        api,
        { status: 'open', sqlText },
        { name, description },
        onSaved,
      );
      if (!result.ok) setError(result.error);
    } catch {
      setError('The saved query operation did not respond.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop save-query-modal-backdrop">
      <section className="save-query-dialog" role="dialog" aria-modal="true" aria-labelledby="save-query-title">
        <header>
          <div>
            <h2 id="save-query-title">Save query</h2>
            <p>Store the current SQL Editor contents in this Windows profile.</p>
          </div>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="saved-query-name">
            Name
            <input
              id="saved-query-name"
              autoFocus
              required
              value={name}
              aria-invalid={Boolean(error && !name.trim())}
              onChange={(event) => { setName(event.target.value); setError(undefined); }}
            />
          </label>
          <label htmlFor="saved-query-description">
            Description <span>Optional</span>
            <textarea
              id="saved-query-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {error && <div className="data-message error" role="alert">{error}</div>}
          <footer>
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="submit" disabled={busy || !name.trim() || !sqlText.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
