import { contextBridge, ipcRenderer } from 'electron';
import {
  CONNECTION_PROFILE_CHANNELS,
  type ConnectionProfile,
  type CreateConnectionProfileInput,
  type IpcResult,
  type SupraDesktopApi,
  type UpdateConnectionProfileInput,
} from '../shared/connectionProfiles';
import {
  POSTGRES_METADATA_CHANNELS,
  type DatabaseColumn,
  type DatabaseMetadataSearchResult,
  type DatabaseObject,
  type DatabaseSchema,
} from '../shared/databaseMetadata';
import {
  POSTGRES_CONNECTION_CHANNELS,
  type ConnectionRequest,
  type ConnectionState,
  type ConnectionTestResult,
} from '../shared/postgresConnection';
import {
  QUERY_EXECUTION_CHANNELS,
  type QueryExecutionResponse,
  type QueryOperationState,
} from '../shared/queryExecution';
import {
  LOCAL_QUERY_DATA_CHANNELS,
  type AuditLogEntry,
  type CreateSavedQueryInput,
  type QueryActivityExportRequest,
  type QueryActivityExportResult,
  type QueryHistoryEntry,
  type SavedQuery,
  type UpdateSavedQueryInput,
} from '../shared/localQueryData';
import {
  MUTATION_TRANSACTION_CHANNELS,
  type MutationTransactionState,
  type PendingMutationTransaction,
  type PreparedMutation,
} from '../shared/mutationTransaction';

const api: SupraDesktopApi = {
  getPlatform: () => ipcRenderer.invoke('app:get-platform') as Promise<string>,
  listProfiles: () =>
    ipcRenderer.invoke(CONNECTION_PROFILE_CHANNELS.list) as Promise<IpcResult<ConnectionProfile[]>>,
  createProfile: (input: CreateConnectionProfileInput) =>
    ipcRenderer.invoke(CONNECTION_PROFILE_CHANNELS.create, input) as Promise<IpcResult<ConnectionProfile>>,
  updateProfile: (input: UpdateConnectionProfileInput) =>
    ipcRenderer.invoke(CONNECTION_PROFILE_CHANNELS.update, input) as Promise<IpcResult<ConnectionProfile>>,
  deleteProfile: (id: string) =>
    ipcRenderer.invoke(CONNECTION_PROFILE_CHANNELS.delete, id) as Promise<IpcResult<{ id: string }>>,
  testConnection: (request: ConnectionRequest) =>
    ipcRenderer.invoke(POSTGRES_CONNECTION_CHANNELS.test, request) as Promise<IpcResult<ConnectionTestResult>>,
  connect: (request: ConnectionRequest) =>
    ipcRenderer.invoke(POSTGRES_CONNECTION_CHANNELS.connect, request) as Promise<IpcResult<ConnectionState>>,
  disconnect: () =>
    ipcRenderer.invoke(POSTGRES_CONNECTION_CHANNELS.disconnect) as Promise<IpcResult<ConnectionState>>,
  getConnectionState: () =>
    ipcRenderer.invoke(POSTGRES_CONNECTION_CHANNELS.getState) as Promise<IpcResult<ConnectionState>>,
  onConnectionStateChanged: (listener: (state: ConnectionState) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: ConnectionState) => listener(state);
    ipcRenderer.on(POSTGRES_CONNECTION_CHANNELS.stateChanged, wrappedListener);
    return () => ipcRenderer.removeListener(POSTGRES_CONNECTION_CHANNELS.stateChanged, wrappedListener);
  },
  listSchemas: () =>
    ipcRenderer.invoke(POSTGRES_METADATA_CHANNELS.listSchemas) as Promise<IpcResult<DatabaseSchema[]>>,
  listSchemaObjects: (schema: string) =>
    ipcRenderer.invoke(POSTGRES_METADATA_CHANNELS.listSchemaObjects, schema) as Promise<IpcResult<DatabaseObject[]>>,
  listColumns: (schema: string, objectName: string) =>
    ipcRenderer.invoke(POSTGRES_METADATA_CHANNELS.listColumns, schema, objectName) as Promise<IpcResult<DatabaseColumn[]>>,
  searchDatabaseMetadata: (term: string) =>
    ipcRenderer.invoke(POSTGRES_METADATA_CHANNELS.searchDatabaseMetadata, term) as Promise<IpcResult<DatabaseMetadataSearchResult[]>>,
  executeSelect: (sql: string) =>
    ipcRenderer.invoke(QUERY_EXECUTION_CHANNELS.executeSelect, sql) as Promise<QueryExecutionResponse>,
  cancelSelect: (operationId: string) =>
    ipcRenderer.invoke(QUERY_EXECUTION_CHANNELS.cancelSelect, operationId) as Promise<IpcResult<QueryOperationState>>,
  getQueryOperationState: () =>
    ipcRenderer.invoke(QUERY_EXECUTION_CHANNELS.getState) as Promise<IpcResult<QueryOperationState>>,
  onQueryOperationStateChanged: (listener: (state: QueryOperationState) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: QueryOperationState) => listener(state);
    ipcRenderer.on(QUERY_EXECUTION_CHANNELS.stateChanged, wrappedListener);
    return () => ipcRenderer.removeListener(QUERY_EXECUTION_CHANNELS.stateChanged, wrappedListener);
  },
  listSavedQueries: () =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.listSavedQueries) as Promise<IpcResult<SavedQuery[]>>,
  createSavedQuery: (input: CreateSavedQueryInput) =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.createSavedQuery, input) as Promise<IpcResult<SavedQuery>>,
  updateSavedQuery: (input: UpdateSavedQueryInput) =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.updateSavedQuery, input) as Promise<IpcResult<SavedQuery>>,
  deleteSavedQuery: (id: string) =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.deleteSavedQuery, id) as Promise<IpcResult<{ id: string }>>,
  listQueryHistory: () =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.listQueryHistory) as Promise<IpcResult<QueryHistoryEntry[]>>,
  listAuditLog: () =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.listAuditLog) as Promise<IpcResult<AuditLogEntry[]>>,
  exportQueryActivity: (request: QueryActivityExportRequest) =>
    ipcRenderer.invoke(LOCAL_QUERY_DATA_CHANNELS.exportQueryActivity, request) as Promise<IpcResult<QueryActivityExportResult>>,
  prepareMutation: (sql: string) =>
    ipcRenderer.invoke(MUTATION_TRANSACTION_CHANNELS.prepare, sql) as Promise<IpcResult<PreparedMutation>>,
  executeMutation: (preparationId: string) =>
    ipcRenderer.invoke(MUTATION_TRANSACTION_CHANNELS.execute, preparationId) as Promise<IpcResult<PendingMutationTransaction>>,
  commitMutation: (transactionId: string) =>
    ipcRenderer.invoke(MUTATION_TRANSACTION_CHANNELS.commit, transactionId) as Promise<IpcResult<MutationTransactionState>>,
  rollbackMutation: (transactionId: string) =>
    ipcRenderer.invoke(MUTATION_TRANSACTION_CHANNELS.rollback, transactionId) as Promise<IpcResult<MutationTransactionState>>,
  getMutationState: () =>
    ipcRenderer.invoke(MUTATION_TRANSACTION_CHANNELS.getState) as Promise<IpcResult<MutationTransactionState>>,
  onMutationStateChanged: (listener: (state: MutationTransactionState) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: MutationTransactionState) => listener(state);
    ipcRenderer.on(MUTATION_TRANSACTION_CHANNELS.stateChanged, wrappedListener);
    return () => ipcRenderer.removeListener(MUTATION_TRANSACTION_CHANNELS.stateChanged, wrappedListener);
  },
};

contextBridge.exposeInMainWorld('supraDesktop', api);
