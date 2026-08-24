export interface EditorLoadRequest {
  sqlText: string;
  sourceLabel: string;
  requiresConfirmation: boolean;
}

export function prepareEditorLoad(
  sqlText: string,
  currentEditorSql: string,
  sourceLabel: string,
): EditorLoadRequest {
  return {
    sqlText,
    sourceLabel,
    requiresConfirmation: currentEditorSql.trim().length > 0,
  };
}

export function commitEditorLoad(
  request: EditorLoadRequest,
  replaceEditorContents: (sqlText: string) => void,
): void {
  replaceEditorContents(request.sqlText);
}
