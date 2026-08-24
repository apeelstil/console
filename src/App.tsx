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
import { AuditLogView, QueryHistoryView } from './components/QueryActivityViews';
import { SqlReplaceConfirmation } from './components/SqlReplaceConfirmation';
import { MutationConfirmationDialog } from './components/MutationConfirmationDialog';
import { PendingTransactionPanel } from './components/PendingTransactionPanel';
import { commitEditorLoad, prepareEditorLoad, type EditorLoadRequest } from './editorLoadPolicy';
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
  const [queryBuilder, setQueryBuilder] = useState(createQueryBuilderState);
  const [execution, setExecution] = useState<ExecutionViewState>({ status: 'idle' });
  const [queryOperation, setQueryOperation] = useState<QueryOperationState>({ status: 'IDLE' });
  const [pendingEditorLoad, setPendingEditorLoad] = useState<EditorLoadRequest>();
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
  const canExecute = connected && sql.trim().length > 0 && !executing && !postgresOperationsBlocked && !mutationBusy;
  const canExecuteChange = connected
    && sql.trim().length > 0
    && !executing
    && !postgresOperationsBlocked
    && !mutationBusy;

  const loadSqlIntoEditor = useCallback((nextSql: string, sourceLabel: string) => {
    const request = prepareEditorLoad(nextSql, sql, sourceLabel);
    if (request.requiresConfirmation) {
      setPendingEditorLoad(request);
      return;
    }
    commitEditorLoad(request, setSql);
    setSection('workspace');
  }, [sql]);

  const confirmEditorLoad = () => {
    if (!pendingEditorLoad) return;
    commitEditorLoad(pendingEditorLoad, setSql);
    setPendingEditorLoad(undefined);
    setSection('workspace');
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
          error: { kind: 'EXECUTION', message: 'SELECT execution is unavailable.' },
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
        error: { kind: 'EXECUTION', message: 'SELECT execution did not respond.' },
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
        error: { kind: 'EXECUTION', message: 'Query cancellation did not respond.' },
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
      setExecution({ status: 'error', error: { kind: 'EXECUTION', message: 'Mutation validation did not respond.' } });
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
      setMutationError('Mutation execution did not respond.');
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
      setMutationError(`The ${action} operation did not respond.`);
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

  return (
    <div className="app-shell">
      {displayedEnvironment && isProductionEnvironment(displayedEnvironment) && <div className="production-banner">PRODUCTION DATABASE</div>}
      <header className="topbar">
        <div className="brand"><span className="brand-mark">SQ</span><strong>SUPRA Query Console</strong></div>
        <nav className="top-actions">
          <button className="toolbar-button" disabled={connected || disconnecting} onClick={() => setConnectionOpen(true)}>New connection</button>
          {connected && activeConnection && <span className={`connection-summary ${activeConnection.environment === 'PROD' ? 'prod' : ''}`}><b>{activeConnection.name}</b><em>{activeConnection.environment}</em><span>{activeConnection.database}</span><span>{activeConnection.username}</span></span>}
          {(connected || disconnecting) && <button className="disconnect-button" disabled={disconnecting || transactionBusy} title={transactionPending ? 'The pending transaction will be rolled back before disconnect.' : executing ? 'The running SELECT will be cancelled and rolled back before disconnect.' : undefined} onClick={() => void disconnect()}>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</button>}
          <span className={`status ${connectionState.status.toLowerCase()}`}><i />{formatConnectionStatus(connectionState.status)}</span>
        </nav>
      </header>
      {connectionState.status === 'ERROR' && connectionState.message && (
        <div className="connection-alert" role="alert"><span>Connection error</span>{connectionState.message}</div>
      )}
      {postgresOperationsBlocked && (
        <div className="uncommitted-banner" role="alert">
          <strong>UNCOMMITTED TRANSACTION</strong>
          <span>SELECT, metadata and other PostgreSQL operations are blocked until COMMIT or ROLLBACK.</span>
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
            <button className={section === 'workspace' ? 'active' : ''} onClick={() => setSection('workspace')}>⌨ <span>SQL Workspace</span></button>
            <button className={section === 'saved' ? 'active' : ''} onClick={() => setSection('saved')}>☆ <span>Saved Queries</span></button>
            <button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}>◷ <span>Query History</span></button>
            <button className={section === 'audit' ? 'active' : ''} onClick={() => setSection('audit')}>≡ <span>Audit Log</span></button>
          </div>
        </aside>

        <main className="main-area">
          {section === 'workspace' ? <>
            <QueryBuilder
              key={builderObjectKey}
              state={queryBuilder}
              editorSql={sql}
              onChange={setQueryBuilder}
              onGeneratedSql={setSql}
            />
            <section className="editor panel">
              <div className="panel-heading"><span>SQL Editor</span><div><span className="readonly-label">SELECT: Ctrl+Enter</span><button className="change-button" disabled={!canExecuteChange} onClick={() => void prepareMutation()} title="Validate one INSERT/UPDATE and request confirmation">Execute change</button><button disabled={!canExecute} onClick={() => void executeSelect()} title={connected ? 'Execute one validated SELECT (Ctrl+Enter)' : 'Connect to a database first.'}>{executing ? 'Executing...' : '▶ Execute SELECT'}</button>{executing && <button className="cancel-query-button" disabled={cancelling} onClick={() => void cancelSelect()}>{cancelling ? 'Cancelling...' : 'Cancel query'}</button>}</div></div>
              <div className="editor-body"><div className="line-numbers">{Array.from({ length: editorLineCount }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea spellCheck={false} value={sql} placeholder="Write one SELECT or generate it with Query Builder" onChange={(event) => setSql(event.target.value)} onKeyDown={handleEditorKeyDown} aria-label="SQL editor" /></div>
              <div className="editor-status"><span>Ln 1, Col 1</span><span>SELECT read-only · changes require confirmation + COMMIT/ROLLBACK</span></div>
            </section>
            <section className="output panel">
              <div className="tabs"><button className={bottomTab === 'results' ? 'active' : ''} onClick={() => setBottomTab('results')}>Results</button><button className={bottomTab === 'messages' ? 'active' : ''} onClick={() => setBottomTab('messages')}>Messages</button></div>
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
                  : <div className="output-empty"><span>▦</span><strong>{cancelling ? 'Cancelling...' : executing ? 'Executing...' : 'Execute a query to see results'}</strong><small>{executing ? 'The query is running in a read-only transaction' : 'Query output will appear in this panel'}</small></div>
              ) : execution.status === 'error' ? (
                <div className="execution-message" role="alert">
                  <span className="message-kind">{formatExecutionErrorKind(execution.error.kind)}</span>
                  <strong>{execution.error.message}</strong>
                  <div>
                    {execution.error.sqlState && <span>SQLSTATE {execution.error.sqlState}</span>}
                    {execution.error.position !== undefined && <span>Position {execution.error.position}</span>}
                  </div>
                  {execution.error.storageWarnings?.map((warning) => (
                    <div className="storage-warning" role="alert" key={warning}>{warning}</div>
                  ))}
                </div>
              ) : <div className="output-empty"><span>ⓘ</span><strong>No messages</strong><small>Execution errors will appear here</small></div>}
            </section>
          </> : section === 'saved' ? (
            <SavedQueriesView editorSql={sql} onLoadSql={loadSqlIntoEditor} />
          ) : section === 'history' ? (
            <QueryHistoryView onLoadSql={loadSqlIntoEditor} />
          ) : <AuditLogView />}
        </main>
      </div>

      {connectionOpen && <ConnectionDialog connectionState={connectionState} onClose={() => setConnectionOpen(false)} onConnected={() => setConnectionOpen(false)} onEnvironmentChange={setConnectionEnvironment} />}
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
    case 'SYNTAX': return 'Syntax error';
    case 'NOT_ALLOWED': return 'Statement not allowed';
    case 'TIMEOUT': return 'Query timeout';
    case 'CANCELLED': return 'Query cancelled';
    case 'PERMISSION_DENIED': return 'Permission denied';
    case 'CONNECTION': return 'Connection error';
    default: return 'Query execution error';
  }
}

function formatConnectionStatus(status: ConnectionState['status']): string {
  switch (status) {
    case 'TESTING': return 'Testing';
    case 'CONNECTING': return 'Connecting';
    case 'CONNECTED': return 'Connected';
    case 'DISCONNECTING': return 'Disconnecting';
    case 'ERROR': return 'Connection error';
    default: return 'Disconnected';
  }
}
