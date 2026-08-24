import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isProductionEnvironment, type ConnectionEnvironment } from '../shared/connectionProfiles';
import type { ConnectionState } from '../shared/postgresConnection';
import type {
  QueryExecutionErrorDto,
  QueryOperationState,
  SelectQueryResult,
} from '../shared/queryExecution';
import type {
  MutationTransactionState,
  PendingMutationTransaction,
  PreparedMutation,
} from '../shared/mutationTransaction';
import { ConnectionDialog } from './components/ConnectionDialog';
import { DatabaseExplorer } from './components/DatabaseExplorer';
import { QueryBuilder } from './components/QueryBuilder';
import { ResultsGrid } from './components/ResultsGrid';
import { SavedQueriesView } from './components/SavedQueriesView';
import { SaveQueryDialog } from './components/SaveQueryDialog';
import { AuditLogView, QueryHistoryView } from './components/QueryActivityViews';
import { SqlReplaceConfirmation } from './components/SqlReplaceConfirmation';
import { MutationConfirmationDialog } from './components/MutationConfirmationDialog';
import { PendingTransactionPanel } from './components/PendingTransactionPanel';
import { commitEditorLoad, prepareEditorLoad, type EditorLoadRequest } from './editorLoadPolicy';
import {
  isSaveQueryAvailable,
  openSaveQueryDialog,
  type SaveQueryDialogState,
} from './savedQueryUi';
import type { DatabaseExplorerSelection } from './databaseExplorerController';
import {
  createQueryBuilderState,
  synchronizeBuilderSelection,
} from './queryBuilder/queryBuilderModel';

type WorkspaceSection = 'workspace' | 'saved' | 'history' | 'audit';
type ExecutionViewState =
  | { status: 'idle' }
  | { status: 'success'; result: SelectQueryResult }
  | { status: 'error'; error: QueryExecutionErrorDto };

export function App() {
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [connectionEnvironment, setConnectionEnvironment] = useState<ConnectionEnvironment>('DEV');
  const [connectionState, setConnectionState] = useState<ConnectionState>({ status: 'DISCONNECTED' });
  const [section, setSection] = useState<WorkspaceSection>('workspace');
  const [bottomTab, setBottomTab] = useState<'results' | 'messages'>('results');
  const [sql, setSql] = useState('');
  const [editorPosition, setEditorPosition] = useState({ line: 1, column: 1 });
  const [queryBuilder, setQueryBuilder] = useState(createQueryBuilderState);
  const [execution, setExecution] = useState<ExecutionViewState>({ status: 'idle' });
  const [queryOperation, setQueryOperation] = useState<QueryOperationState>({ status: 'IDLE' });
  const [pendingEditorLoad, setPendingEditorLoad] = useState<EditorLoadRequest>();
  const [saveQueryDialog, setSaveQueryDialog] = useState<SaveQueryDialogState>({ status: 'closed' });
  const [savedQueriesRevision, setSavedQueriesRevision] = useState(0);
  const [saveQueryFeedback, setSaveQueryFeedback] = useState<string>();
  const [mutationState, setMutationState] = useState<MutationTransactionState>({ status: 'IDLE' });
  const [mutationPreparation, setMutationPreparation] = useState<PreparedMutation>();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationAction, setMutationAction] = useState<'COMMIT' | 'ROLLBACK'>();
  const [mutationError, setMutationError] = useState<string>();
  const executionLock = useRef(false);

  useEffect(() => {
    const api = window.supraDesktop;
    if (!api) return;

    const unsubscribe = api.onConnectionStateChanged(setConnectionState);
    void api.getConnectionState().then((result) => {
      if (result.ok) setConnectionState(result.data);
    }).catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!saveQueryFeedback) return;
    const timeout = window.setTimeout(() => setSaveQueryFeedback(undefined), 3000);
    return () => window.clearTimeout(timeout);
  }, [saveQueryFeedback]);

  useEffect(() => {
    const api = window.supraDesktop;
    if (!api) return;
    const unsubscribe = api.onMutationStateChanged(setMutationState);
    void api.getMutationState().then((result) => {
      if (result.ok) setMutationState(result.data);
    }).catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const api = window.supraDesktop;
    if (!api) return;
    const unsubscribe = api.onQueryOperationStateChanged(setQueryOperation);
    void api.getQueryOperationState().then((result) => {
      if (result.ok) setQueryOperation(result.data);
    }).catch(() => undefined);
    return unsubscribe;
  }, []);

  const disconnect = async () => {
    const api = window.supraDesktop;
    if (!api) return;
    const result = await api.disconnect();
    if (result.ok) setConnectionState(result.data);
  };

  const connected = connectionState.status === 'CONNECTED';
  const disconnecting = connectionState.status === 'DISCONNECTING';
  const executing = queryOperation.status !== 'IDLE';
  const cancelling = queryOperation.status === 'CANCELLING';
  const transactionPending = mutationState.status === 'PENDING_CONFIRMATION';
  const transactionBusy = mutationState.status === 'EXECUTING'
    || mutationState.status === 'COMMITTING'
    || mutationState.status === 'ROLLING_BACK';
  const postgresOperationsBlocked = transactionPending || transactionBusy;
  const transactionMessage = 'message' in mutationState ? mutationState.message : undefined;
  const activeConnection = connectionState.connection;
  const displayedEnvironment = activeConnection?.environment ?? (connectionOpen ? connectionEnvironment : undefined);
  const handleExplorerSelection = useCallback((selection?: DatabaseExplorerSelection) => {
    setQueryBuilder((current) => synchronizeBuilderSelection(current, selection));
  }, []);
  const builderObjectKey = queryBuilder.object
    ? JSON.stringify([queryBuilder.object.schema, queryBuilder.object.name, queryBuilder.object.type])
    : 'no-object';
  const editorLineCount = Math.max(1, sql.split('\n').length);
  const selectedDatabaseObject = queryBuilder.object
    ? `${queryBuilder.object.schema}.${queryBuilder.object.name}`
    : 'Объект базы данных не выбран';
  const canExecute = connected && sql.trim().length > 0 && !executing && !postgresOperationsBlocked && !mutationBusy;
  const canSaveQuery = isSaveQueryAvailable(sql);
  const canExecuteChange = connected
    && sql.trim().length > 0
    && !executing
    && !postgresOperationsBlocked
    && !mutationBusy;

  const replaceEditorSql = useCallback((nextSql: string): void => {
    setSql(nextSql);
    setEditorPosition({ line: 1, column: 1 });
  }, []);

  const loadSqlIntoEditor = useCallback((nextSql: string, sourceLabel: string) => {
    const request = prepareEditorLoad(nextSql, sql, sourceLabel);
    if (request.requiresConfirmation) {
      setPendingEditorLoad(request);
      return;
    }
    commitEditorLoad(request, replaceEditorSql);
    setSection('workspace');
  }, [replaceEditorSql, sql]);

  const confirmEditorLoad = () => {
    if (!pendingEditorLoad) return;
    commitEditorLoad(pendingEditorLoad, replaceEditorSql);
    setPendingEditorLoad(undefined);
    setSection('workspace');
  };

  const beginSaveQuery = () => {
    const nextDialog = openSaveQueryDialog(sql);
    if (nextDialog.status === 'open') {
      setSaveQueryFeedback(undefined);
      setSaveQueryDialog(nextDialog);
    }
  };

  const completeSaveQuery = () => {
    setSaveQueryDialog({ status: 'closed' });
    setSavedQueriesRevision((revision) => revision + 1);
    setSaveQueryFeedback('Запрос сохранён локально.');
  };

  const executeSelect = async () => {
    if (!canExecute || executionLock.current) return;
    executionLock.current = true;
    setExecution({ status: 'idle' });
    setBottomTab('results');

    try {
      const api = window.supraDesktop;
      if (!api) {
        setExecution({
          status: 'error',
          error: { kind: 'EXECUTION', message: 'Выполнение SELECT недоступно.' },
        });
        setBottomTab('messages');
        return;
      }

      const response = await api.executeSelect(sql);
      if (response.ok) {
        setExecution({ status: 'success', result: response.data });
        setBottomTab('results');
      } else {
        setExecution({ status: 'error', error: response.error });
        setBottomTab('messages');
      }
    } catch {
      setExecution({
        status: 'error',
        error: { kind: 'EXECUTION', message: 'Выполнение SELECT не отвечает.' },
      });
      setBottomTab('messages');
    } finally {
      executionLock.current = false;
    }
  };

  const cancelSelect = async () => {
    const api = window.supraDesktop;
    if (!api || queryOperation.status !== 'EXECUTING') return;
    const result = await api.cancelSelect(queryOperation.operationId).catch(() => undefined);
    if (!result) {
      setExecution({
        status: 'error',
        error: { kind: 'EXECUTION', message: 'Отмена запроса не отвечает.' },
      });
      setBottomTab('messages');
      return;
    }
    if (!result.ok) {
      setExecution({
        status: 'error',
        error: { kind: 'EXECUTION', message: result.error },
      });
      setBottomTab('messages');
    }
  };

  const prepareMutation = async () => {
    if (!canExecuteChange) return;
    const api = window.supraDesktop;
    if (!api) return;
    setMutationBusy(true);
    setMutationError(undefined);
    try {
      const result = await api.prepareMutation(sql);
      if (!result.ok) {
        setExecution({ status: 'error', error: { kind: 'NOT_ALLOWED', message: result.error } });
        setBottomTab('messages');
        return;
      }
      setMutationPreparation(result.data);
    } catch {
      setExecution({ status: 'error', error: { kind: 'EXECUTION', message: 'Проверка INSERT/UPDATE не отвечает.' } });
      setBottomTab('messages');
    } finally {
      setMutationBusy(false);
    }
  };

  const executePreparedMutation = async () => {
    const api = window.supraDesktop;
    if (!api || !mutationPreparation || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(undefined);
    try {
      const result = await api.executeMutation(mutationPreparation.preparationId);
      if (!result.ok) {
        setMutationError(result.error);
        return;
      }
      setMutationState(result.data);
      setMutationPreparation(undefined);
    } catch {
      setMutationError('Выполнение INSERT/UPDATE не отвечает.');
    } finally {
      setMutationBusy(false);
    }
  };

  const finishMutation = async (action: 'COMMIT' | 'ROLLBACK') => {
    const api = window.supraDesktop;
    if (!api || mutationState.status !== 'PENDING_CONFIRMATION' || mutationBusy) return;
    setMutationBusy(true);
    setMutationAction(action);
    setMutationError(undefined);
    try {
      const result = action === 'COMMIT'
        ? await api.commitMutation(mutationState.transactionId)
        : await api.rollbackMutation(mutationState.transactionId);
      if (!result.ok) {
        setMutationError(result.error);
        return;
      }
      setMutationState(result.data);
    } catch {
      setMutationError(`Операция ${action} не отвечает.`);
    } finally {
      setMutationBusy(false);
      setMutationAction(undefined);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      void executeSelect();
    }
  };

  function updateEditorPosition(value: string, selectionStart: number): void {
    const textBeforeCursor = value.slice(0, selectionStart);
    const lines = textBeforeCursor.split('\n');
    setEditorPosition({
      line: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
    });
  }

  return (
    <div className="app-shell">
      {displayedEnvironment && isProductionEnvironment(displayedEnvironment) && <div className="production-banner">PRODUCTION DATABASE</div>}
      <header className="topbar">
        <div className="brand"><span className="brand-mark">SQ</span><span className="brand-copy"><strong>SUPRA Query Console</strong><small>Рабочее место поддержки БД</small></span></div>
        <nav className="top-actions">
          <button type="button" className="toolbar-button" disabled={connected || disconnecting} onClick={() => setConnectionOpen(true)}>＋ Подключение</button>
          {connected && activeConnection && <span className={`connection-summary ${activeConnection.environment === 'PROD' ? 'prod' : ''}`}><b>{activeConnection.name}</b><em>{activeConnection.environment}</em><span>{activeConnection.database}</span><span>{activeConnection.username}</span></span>}
          {(connected || disconnecting) && <button type="button" className="disconnect-button" disabled={disconnecting || transactionBusy} title={transactionPending ? 'Незавершённая транзакция будет отменена перед отключением.' : executing ? 'Выполняющийся SELECT будет отменён перед отключением.' : undefined} onClick={() => void disconnect()}>{disconnecting ? 'Отключение…' : 'Отключиться'}</button>}
          <span className={`status ${connectionState.status.toLowerCase()}`} role="status" aria-live="polite"><i />{formatConnectionStatus(connectionState.status)}</span>
        </nav>
      </header>
      {connectionState.status === 'ERROR' && connectionState.message && (
        <div className="connection-alert" role="alert"><span>Ошибка подключения</span>{connectionState.message}</div>
      )}
      {postgresOperationsBlocked && (
        <div className="uncommitted-banner" role="alert">
          <strong>НЕЗАФИКСИРОВАННАЯ ТРАНЗАКЦИЯ</strong>
          <span>SELECT, метаданные и другие операции PostgreSQL заблокированы до COMMIT или ROLLBACK.</span>
        </div>
      )}
      {!postgresOperationsBlocked && transactionMessage && (
        <div className="transaction-resolution" role="status">{transactionMessage}</div>
      )}

      <div className="desktop">
        <aside className="sidebar">
          <DatabaseExplorer
            connection={connected ? activeConnection : undefined}
            onSelectionChange={handleExplorerSelection}
          />
          <div className="side-nav">
            <button type="button" className={section === 'workspace' ? 'active' : ''} onClick={() => setSection('workspace')}><i>⌨</i><span>SQL-редактор</span></button>
            <button type="button" className={section === 'saved' ? 'active' : ''} onClick={() => setSection('saved')}><i>☆</i><span>Сохранённые запросы</span></button>
            <button type="button" className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}><i>◷</i><span>История запросов</span></button>
            <button type="button" className={section === 'audit' ? 'active' : ''} onClick={() => setSection('audit')}><i>≡</i><span>Журнал аудита</span></button>
          </div>
        </aside>

        <main className={`main-area ${section === 'workspace' ? 'workspace-layout' : 'data-layout'}`}>
          {section === 'workspace' ? <>
            <div className="workspace-header">
              <div className="workspace-breadcrumb"><span>SQL-редактор</span><b>›</b><strong title={selectedDatabaseObject}>{selectedDatabaseObject}</strong></div>
              <div className="workspace-badges">
                <span className="safety-badge">БЕЗОПАСНЫЙ SELECT</span>
                {queryOperation.status !== 'IDLE' && (
                  <span className={`query-operation-status ${cancelling ? 'cancelling' : 'executing'}`} role="status" aria-live="polite"><i />{cancelling ? 'ОТМЕНА' : 'ВЫПОЛНЕНИЕ'}</span>
                )}
              </div>
            </div>
            <QueryBuilder
              key={builderObjectKey}
              state={queryBuilder}
              editorSql={sql}
              onChange={setQueryBuilder}
              onGeneratedSql={replaceEditorSql}
            />
            <section className="editor panel">
              <div className="panel-heading">
                <span>SQL-редактор</span>
                <div>
                  {saveQueryFeedback && <span className="editor-save-feedback" role="status">✓ {saveQueryFeedback}</span>}
                  <span className="readonly-label">Ctrl+Enter — выполнить</span>
                  <button type="button" className="save-query-button" disabled={!canSaveQuery} onClick={beginSaveQuery} title={canSaveQuery ? 'Сохранить содержимое SQL-редактора' : 'Введите SQL перед сохранением.'}>☆ Сохранить запрос</button>
                  <button type="button" className="change-button" disabled={!canExecuteChange} onClick={() => void prepareMutation()} title="Проверить INSERT/UPDATE и запросить подтверждение">Выполнить изменение</button>
                  <button type="button" disabled={!canExecute} onClick={() => void executeSelect()} title={connected ? 'Выполнить проверенный SELECT (Ctrl+Enter)' : 'Сначала подключитесь к базе данных.'}>{executing ? 'Выполнение…' : '▶ Выполнить SELECT'}</button>
                  {executing && <button type="button" className="cancel-query-button" disabled={cancelling} onClick={() => void cancelSelect()}>{cancelling ? 'Отмена…' : 'Отменить запрос'}</button>}
                </div>
              </div>
              <div className="editor-body"><div className="line-numbers">{Array.from({ length: editorLineCount }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea spellCheck={false} value={sql} placeholder="Введите один SELECT или создайте его в конструкторе" onChange={(event) => { setSql(event.target.value); updateEditorPosition(event.target.value, event.target.selectionStart); }} onSelect={(event) => updateEditorPosition(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={handleEditorKeyDown} aria-label="SQL-редактор" /></div>
              <div className="editor-status"><span>Строка {editorPosition.line}, столбец {editorPosition.column}</span><span>SELECT — только чтение · изменения требуют подтверждения и COMMIT/ROLLBACK</span></div>
            </section>
            <section className="output panel">
              <div className="tabs"><button type="button" className={bottomTab === 'results' ? 'active' : ''} onClick={() => setBottomTab('results')}>Результаты</button><button type="button" className={bottomTab === 'messages' ? 'active' : ''} onClick={() => setBottomTab('messages')}>Сообщения</button></div>
              {transactionPending ? (
                <PendingTransactionPanel
                  transaction={mutationState as PendingMutationTransaction}
                  busyAction={mutationAction}
                  error={mutationError}
                  onCommit={() => void finishMutation('COMMIT')}
                  onRollback={() => void finishMutation('ROLLBACK')}
                />
              ) : bottomTab === 'results' ? (
                execution.status === 'success'
                  ? <ResultsGrid result={execution.result} />
                  : <div className="output-empty"><span>▦</span><strong>{cancelling ? 'Отмена запроса…' : executing ? 'Выполнение…' : 'Выполните запрос, чтобы увидеть результат'}</strong><small>{executing ? 'Запрос выполняется в транзакции только для чтения' : 'Результат запроса появится в этой области'}</small></div>
              ) : execution.status === 'error' ? (
                <div className="execution-message" role="alert">
                  <span className="message-kind">{formatExecutionErrorKind(execution.error.kind)}</span>
                  <strong>{execution.error.message}</strong>
                  <div>
                    {execution.error.sqlState && <span>SQLSTATE {execution.error.sqlState}</span>}
                    {execution.error.position !== undefined && <span>Позиция {execution.error.position}</span>}
                  </div>
                  {execution.error.storageWarnings?.map((warning) => (
                    <div className="storage-warning" role="alert" key={warning}>{warning}</div>
                  ))}
                </div>
              ) : <div className="output-empty"><span>ⓘ</span><strong>Нет сообщений</strong><small>Ошибки выполнения появятся здесь</small></div>}
            </section>
          </> : section === 'saved' ? (
            <SavedQueriesView editorSql={sql} refreshVersion={savedQueriesRevision} onLoadSql={loadSqlIntoEditor} />
          ) : section === 'history' ? (
            <QueryHistoryView onLoadSql={loadSqlIntoEditor} />
          ) : <AuditLogView />}
        </main>
      </div>

      {connectionOpen && <ConnectionDialog connectionState={connectionState} onClose={() => setConnectionOpen(false)} onConnected={() => setConnectionOpen(false)} onEnvironmentChange={setConnectionEnvironment} />}
      {saveQueryDialog.status === 'open' && (
        <SaveQueryDialog
          sqlText={saveQueryDialog.sqlText}
          onCancel={() => setSaveQueryDialog({ status: 'closed' })}
          onSaved={completeSaveQuery}
        />
      )}
      {pendingEditorLoad && (
        <SqlReplaceConfirmation
          sourceLabel={pendingEditorLoad.sourceLabel}
          onCancel={() => setPendingEditorLoad(undefined)}
          onReplace={confirmEditorLoad}
        />
      )}
      {mutationPreparation && (
        <MutationConfirmationDialog
          preparation={mutationPreparation}
          busy={mutationBusy}
          error={mutationError}
          onCancel={() => { setMutationPreparation(undefined); setMutationError(undefined); }}
          onConfirm={() => void executePreparedMutation()}
        />
      )}
    </div>
  );
}

function formatExecutionErrorKind(kind: QueryExecutionErrorDto['kind']): string {
  switch (kind) {
    case 'SYNTAX': return 'Синтаксическая ошибка';
    case 'NOT_ALLOWED': return 'Запрос запрещён';
    case 'TIMEOUT': return 'Превышено время выполнения запроса';
    case 'CANCELLED': return 'Запрос отменён';
    case 'PERMISSION_DENIED': return 'Недостаточно прав';
    case 'CONNECTION': return 'Ошибка подключения';
    default: return 'Ошибка выполнения запроса';
  }
}

function formatConnectionStatus(status: ConnectionState['status']): string {
  switch (status) {
    case 'TESTING': return 'ПРОВЕРКА';
    case 'CONNECTING': return 'ПОДКЛЮЧЕНИЕ';
    case 'CONNECTED': return 'ПОДКЛЮЧЕНО';
    case 'DISCONNECTING': return 'ОТКЛЮЧЕНИЕ';
    case 'ERROR': return 'ОШИБКА ПОДКЛЮЧЕНИЯ';
    default: return 'ОТКЛЮЧЕНО';
  }
}
