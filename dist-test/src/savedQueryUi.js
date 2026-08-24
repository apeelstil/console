"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSaveQueryAvailable = isSaveQueryAvailable;
exports.openSaveQueryDialog = openSaveQueryDialog;
exports.saveEditorQuery = saveEditorQuery;
function isSaveQueryAvailable(editorSql) {
    return editorSql.trim().length > 0;
}
function openSaveQueryDialog(editorSql) {
    if (!isSaveQueryAvailable(editorSql))
        return { status: 'closed' };
    return { status: 'open', sqlText: editorSql };
}
async function saveEditorQuery(api, dialog, form, onSaved) {
    if (dialog.status !== 'open' || !isSaveQueryAvailable(dialog.sqlText)) {
        return { ok: false, error: 'SQL cannot be empty.' };
    }
    const name = form.name.trim();
    if (!name)
        return { ok: false, error: 'Saved query name is required.' };
    const result = await api.createSavedQuery({
        name,
        description: form.description.trim() || null,
        sqlText: dialog.sqlText,
    });
    if (result.ok)
        onSaved(result.data);
    return result;
}
