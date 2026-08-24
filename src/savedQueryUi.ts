import type { IpcResult } from '../shared/connectionProfiles';
import type {
  LocalQueryDataApi,
  SavedQuery,
} from '../shared/localQueryData';

export type SaveQueryDialogState =
  | { status: 'closed' }
  | { status: 'open'; sqlText: string };

export interface SaveQueryFormValues {
  name: string;
  description: string;
}

type SavedQueryCreateApi = Pick<LocalQueryDataApi, 'createSavedQuery'>;

export function isSaveQueryAvailable(editorSql: string): boolean {
  return editorSql.trim().length > 0;
}

export function openSaveQueryDialog(editorSql: string): SaveQueryDialogState {
  if (!isSaveQueryAvailable(editorSql)) return { status: 'closed' };
  return { status: 'open', sqlText: editorSql };
}

export async function saveEditorQuery(
  api: SavedQueryCreateApi,
  dialog: SaveQueryDialogState,
  form: SaveQueryFormValues,
  onSaved: (query: SavedQuery) => void,
): Promise<IpcResult<SavedQuery>> {
  if (dialog.status !== 'open' || !isSaveQueryAvailable(dialog.sqlText)) {
    return { ok: false, error: 'SQL не может быть пустым.' };
  }

  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Укажите название сохранённого запроса.' };

  const result = await api.createSavedQuery({
    name,
    description: form.description.trim() || null,
    sqlText: dialog.sqlText,
  });
  if (result.ok) onSaved(result.data);
  return result;
}
