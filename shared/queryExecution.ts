import type { IpcResult } from './connectionProfiles';

export type QueryCellValue = string | number | boolean | null;

export interface QueryResultColumn {
  name: string;
  dataTypeId?: number;
}

export interface SelectQueryResult {
  columns: QueryResultColumn[];
  rows: QueryCellValue[][];
  returnedRows: number;
  truncated: boolean;
  durationMs: number;
  storageWarnings?: string[];
}

export type QueryExecutionErrorKind =
  | 'SYNTAX'
  | 'NOT_ALLOWED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PERMISSION_DENIED'
  | 'CONNECTION'
  | 'EXECUTION';

export interface QueryExecutionErrorDto {
  kind: QueryExecutionErrorKind;
  message: string;
  sqlState?: string;
  position?: number;
  storageWarnings?: string[];
}

export type QueryExecutionResponse =
  | { ok: true; data: SelectQueryResult }
  | { ok: false; error: QueryExecutionErrorDto };

export type QueryOperationState =
  | { status: 'IDLE'; message?: string }
  | { status: 'EXECUTING'; operationId: string; startedAt: string }
  | { status: 'CANCELLING'; operationId: string; startedAt: string };

export interface SelectQueryExecutionApi {
  executeSelect: (sql: string) => Promise<QueryExecutionResponse>;
  cancelSelect: (operationId: string) => Promise<IpcResult<QueryOperationState>>;
  getQueryOperationState: () => Promise<IpcResult<QueryOperationState>>;
  onQueryOperationStateChanged: (listener: (state: QueryOperationState) => void) => () => void;
}

export const QUERY_EXECUTION_CHANNELS = {
  executeSelect: 'query-execution:execute-select',
  cancelSelect: 'query-execution:cancel-select',
  getState: 'query-execution:get-state',
  stateChanged: 'query-execution:state-changed',
} as const;
