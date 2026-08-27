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

export type QueryActivityExportSource = 'HISTORY' | 'AUDIT';
export type QueryActivityExportFormat = 'CSV' | 'JSON';

export interface QueryActivityExportRequest {
  source: QueryActivityExportSource;
  format: QueryActivityExportFormat;
}

export type QueryActivityExportResult =
  | { status: 'SAVED'; recordCount: number }
  | { status: 'CANCELLED' };

export interface LocalQueryDataApi {
  listSavedQueries: () => Promise<IpcResult<SavedQuery[]>>;
  createSavedQuery: (input: CreateSavedQueryInput) => Promise<IpcResult<SavedQuery>>;
  updateSavedQuery: (input: UpdateSavedQueryInput) => Promise<IpcResult<SavedQuery>>;
  deleteSavedQuery: (id: string) => Promise<IpcResult<{ id: string }>>;
  listQueryHistory: () => Promise<IpcResult<QueryHistoryEntry[]>>;
  listAuditLog: () => Promise<IpcResult<AuditLogEntry[]>>;
  exportQueryActivity: (
    request: QueryActivityExportRequest,
  ) => Promise<IpcResult<QueryActivityExportResult>>;
}

export const LOCAL_QUERY_DATA_CHANNELS = {
  listSavedQueries: 'local-query-data:saved:list',
  createSavedQuery: 'local-query-data:saved:create',
  updateSavedQuery: 'local-query-data:saved:update',
  deleteSavedQuery: 'local-query-data:saved:delete',
  listQueryHistory: 'local-query-data:history:list',
  listAuditLog: 'local-query-data:audit:list',
  exportQueryActivity: 'local-query-data:activity:export',
} as const;

export function parseQueryActivityExportRequest(value: unknown): QueryActivityExportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid query activity export request.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'format' || keys[1] !== 'source') {
    throw new Error('Invalid query activity export request.');
  }
  if (record.source !== 'HISTORY' && record.source !== 'AUDIT') {
    throw new Error('Invalid query activity export source.');
  }
  if (record.format !== 'CSV' && record.format !== 'JSON') {
    throw new Error('Invalid query activity export format.');
  }
  return { source: record.source, format: record.format };
}
