import type { ConnectionEnvironment, IpcResult } from './connectionProfiles';

export type QueryActivityStatus = 'SUCCESS' | 'ERROR' | 'BLOCKED' | 'TIMEOUT' | 'CANCELLED';
export type AuditOperation = 'EXECUTE' | 'MUTATION' | 'INSERT' | 'UPDATE' | 'COMMIT' | 'ROLLBACK';
export type AuditOutcome =
  | QueryActivityStatus
  | 'VALIDATED'
  | 'PENDING'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'AUTO_ROLLED_BACK'
  | 'CONNECTION_LOST';

export interface SavedQuery {
  id: string;
  name: string;
  description: string | null;
  sqlText: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedQueryInput {
  name: string;
  description?: string | null;
  sqlText: string;
}

export interface UpdateSavedQueryInput extends CreateSavedQueryInput {
  id: string;
}

export interface QueryHistoryEntry {
  id: string;
  timestamp: string;
  sqlText: string;
  profileName: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  database: string | null;
  databaseUser: string | null;
  status: QueryActivityStatus;
  durationMs: number | null;
  returnedRows: number | null;
  truncated: boolean;
  errorMessage: string | null;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  windowsUser: string;
  computerName: string;
  profileName: string | null;
  environment: ConnectionEnvironment | null;
  host: string | null;
  database: string | null;
  databaseUser: string | null;
  operation: AuditOperation;
  sqlText: string;
  outcome: AuditOutcome;
  durationMs: number | null;
  returnedRows: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface LocalQueryDataApi {
  listSavedQueries: () => Promise<IpcResult<SavedQuery[]>>;
  createSavedQuery: (input: CreateSavedQueryInput) => Promise<IpcResult<SavedQuery>>;
  updateSavedQuery: (input: UpdateSavedQueryInput) => Promise<IpcResult<SavedQuery>>;
  deleteSavedQuery: (id: string) => Promise<IpcResult<{ id: string }>>;
  listQueryHistory: () => Promise<IpcResult<QueryHistoryEntry[]>>;
  listAuditLog: () => Promise<IpcResult<AuditLogEntry[]>>;
}

export const LOCAL_QUERY_DATA_CHANNELS = {
  listSavedQueries: 'local-query-data:saved:list',
  createSavedQuery: 'local-query-data:saved:create',
  updateSavedQuery: 'local-query-data:saved:update',
  deleteSavedQuery: 'local-query-data:saved:delete',
  listQueryHistory: 'local-query-data:history:list',
  listAuditLog: 'local-query-data:audit:list',
} as const;
