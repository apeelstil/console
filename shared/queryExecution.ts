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

export interface SelectQueryExecutionApi {
  executeSelect: (sql: string) => Promise<QueryExecutionResponse>;
}

export const QUERY_EXECUTION_CHANNELS = {
  executeSelect: 'query-execution:execute-select',
} as const;
