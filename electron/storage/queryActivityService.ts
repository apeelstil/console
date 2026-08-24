import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { ActiveConnectionInfo } from '../../shared/postgresConnection';
import type {
  AuditLogEntry,
  AuditOperation,
  AuditOutcome,
  QueryActivityStatus,
  QueryHistoryEntry,
} from '../../shared/localQueryData';

export interface QueryHistoryStore {
  add(entry: QueryHistoryEntry): void;
  list(): QueryHistoryEntry[];
}

export interface AuditLogStore {
  add(entry: AuditLogEntry): void;
  list(): AuditLogEntry[];
}

export interface QueryActivityAttempt {
  sqlText: string;
  connection?: ActiveConnectionInfo;
  status: QueryActivityStatus;
  durationMs: number | null;
  returnedRows: number | null;
  truncated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  operation?: AuditOperation;
  auditOutcome?: AuditOutcome;
}

export interface QueryAuditEvent {
  sqlText: string;
  connection?: ActiveConnectionInfo;
  operation: AuditOperation;
  outcome: AuditOutcome;
  durationMs: number | null;
  returnedRows: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface QueryActivityRecordResult {
  warnings: string[];
}

export interface QueryActivityRecorder {
  recordAttempt(attempt: QueryActivityAttempt): Promise<QueryActivityRecordResult>;
}

export interface MutationActivityRecorder extends QueryActivityRecorder {
  recordAuditEvent(event: QueryAuditEvent): Promise<QueryActivityRecordResult>;
}

export interface AuditIdentityProvider {
  getWindowsUser(): string;
  getComputerName(): string;
}

export class NodeAuditIdentityProvider implements AuditIdentityProvider {
  getWindowsUser(): string {
    return userInfo().username || 'Unknown Windows user';
  }

  getComputerName(): string {
    return hostname() || 'Unknown computer';
  }
}

export class LocalQueryActivityService implements MutationActivityRecorder {
  constructor(
    private readonly historyRepository: QueryHistoryStore,
    private readonly auditRepository: AuditLogStore,
    private readonly identity: AuditIdentityProvider,
    private readonly reportStorageWarning: (message: string) => void = (message) => console.error(message),
  ) {}

  listHistory(): QueryHistoryEntry[] {
    return this.historyRepository.list();
  }

  listAuditLog(): AuditLogEntry[] {
    return this.auditRepository.list();
  }

  async recordAttempt(attempt: QueryActivityAttempt): Promise<QueryActivityRecordResult> {
    const warnings: string[] = [];
    const timestamp = new Date().toISOString();
    const target = toTarget(attempt.connection);

    const historyEntry: QueryHistoryEntry = {
      id: randomUUID(),
      timestamp,
      sqlText: attempt.sqlText,
      ...target,
      status: attempt.status,
      durationMs: attempt.durationMs,
      returnedRows: attempt.returnedRows,
      truncated: attempt.truncated,
      errorMessage: attempt.errorMessage,
    };
    try {
      this.historyRepository.add(historyEntry);
    } catch {
      const message = 'Query history could not be written.';
      warnings.push(message);
      this.reportStorageWarning(`[SUPRA] ${message}`);
    }

    warnings.push(...this.writeAudit({
      id: randomUUID(),
      timestamp,
      windowsUser: '',
      computerName: '',
      ...target,
      operation: attempt.operation ?? 'EXECUTE',
      sqlText: attempt.sqlText,
      outcome: attempt.auditOutcome ?? attempt.status,
      durationMs: attempt.durationMs,
      returnedRows: attempt.returnedRows,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
    }));

    return { warnings };
  }

  async recordAuditEvent(event: QueryAuditEvent): Promise<QueryActivityRecordResult> {
    const warnings = this.writeAudit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      windowsUser: '',
      computerName: '',
      ...toTarget(event.connection),
      operation: event.operation,
      sqlText: event.sqlText,
      outcome: event.outcome,
      durationMs: event.durationMs,
      returnedRows: event.returnedRows,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
    });
    return { warnings };
  }

  private writeAudit(entry: AuditLogEntry): string[] {
    try {
      this.auditRepository.add({
        ...entry,
        windowsUser: this.identity.getWindowsUser(),
        computerName: this.identity.getComputerName(),
      });
      return [];
    } catch {
      const message = 'Audit log could not be written.';
      this.reportStorageWarning(`[SUPRA] ${message}`);
      return [message];
    }
  }
}

function toTarget(connection?: ActiveConnectionInfo) {
  return {
    profileName: connection?.name ?? null,
    environment: connection?.environment ?? null,
    host: connection?.host ?? null,
    database: connection?.database ?? null,
    databaseUser: connection?.username ?? null,
  };
}
