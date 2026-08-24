"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareEditorLoad = prepareEditorLoad;
exports.commitEditorLoad = commitEditorLoad;
function prepareEditorLoad(sqlText, currentEditorSql, sourceLabel) {
    return {
        sqlText,
        sourceLabel,
        requiresConfirmation: currentEditorSql.trim().length > 0,
    };
}
function commitEditorLoad(request, replaceEditorContents) {
    replaceEditorContents(request.sqlText);
}
