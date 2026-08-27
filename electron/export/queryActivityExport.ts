import type {
  AuditLogEntry,
  QueryActivityExportFormat,
  QueryHistoryEntry,
} from '../../shared/localQueryData';

const HISTORY_COLUMNS = [
  'id',
  'timestamp',
  'sqlText',
  'profileName',
  'environment',
  'host',
  'database',
  'databaseUser',
  'status',
  'durationMs',
  'returnedRows',
  'truncated',
  'errorMessage',
] as const satisfies readonly (keyof QueryHistoryEntry)[];

const AUDIT_COLUMNS = [
  'id',
  'timestamp',
  'windowsUser',
  'computerName',
  'profileName',
  'environment',
  'host',
  'database',
  'databaseUser',
  'operation',
  'sqlText',
  'outcome',
  'durationMs',
  'returnedRows',
  'errorCode',
  'errorMessage',
] as const satisfies readonly (keyof AuditLogEntry)[];

export function serializeHistoryExport(
  entries: readonly QueryHistoryEntry[],
  format: QueryActivityExportFormat,
): string {
  const records = entries.map(projectHistoryEntry);
  return format === 'CSV'
    ? serializeCsv(records, HISTORY_COLUMNS)
    : serializeJson(records);
}

export function serializeAuditExport(
  entries: readonly AuditLogEntry[],
  format: QueryActivityExportFormat,
): string {
  const records = entries.map(projectAuditEntry);
  return format === 'CSV'
    ? serializeCsv(records, AUDIT_COLUMNS)
    : serializeJson(records);
}

function serializeCsv<T extends object, K extends keyof T>(
  records: readonly T[],
  columns: readonly K[],
): string {
  const rows = [
    columns.map((column) => escapeCsvCell(String(column))).join(','),
    ...records.map((record) => columns
      .map((column) => escapeCsvCell(formatCellValue(record[column])))
      .join(',')),
  ];
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

function serializeJson<T>(records: readonly T[]): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

function escapeCsvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function projectHistoryEntry(entry: QueryHistoryEntry): QueryHistoryEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    sqlText: entry.sqlText,
    profileName: entry.profileName,
    environment: entry.environment,
    host: entry.host,
    database: entry.database,
    databaseUser: entry.databaseUser,
    status: entry.status,
    durationMs: entry.durationMs,
    returnedRows: entry.returnedRows,
    truncated: entry.truncated,
    errorMessage: entry.errorMessage,
  };
}

function projectAuditEntry(entry: AuditLogEntry): AuditLogEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    windowsUser: entry.windowsUser,
    computerName: entry.computerName,
    profileName: entry.profileName,
    environment: entry.environment,
    host: entry.host,
    database: entry.database,
    databaseUser: entry.databaseUser,
    operation: entry.operation,
    sqlText: entry.sqlText,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    returnedRows: entry.returnedRows,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
  };
}
