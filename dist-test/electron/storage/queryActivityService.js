"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalQueryActivityService = exports.NodeAuditIdentityProvider = void 0;
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
class NodeAuditIdentityProvider {
    getWindowsUser() {
        return (0, node_os_1.userInfo)().username || 'Unknown Windows user';
    }
    getComputerName() {
        return (0, node_os_1.hostname)() || 'Unknown computer';
    }
}
exports.NodeAuditIdentityProvider = NodeAuditIdentityProvider;
class LocalQueryActivityService {
    historyRepository;
    auditRepository;
    identity;
    reportStorageWarning;
    constructor(historyRepository, auditRepository, identity, reportStorageWarning = (message) => console.error(message)) {
        this.historyRepository = historyRepository;
        this.auditRepository = auditRepository;
        this.identity = identity;
        this.reportStorageWarning = reportStorageWarning;
    }
    listHistory() {
        return this.historyRepository.list();
    }
    listAuditLog() {
        return this.auditRepository.list();
    }
    async recordAttempt(attempt) {
        const warnings = [];
        const timestamp = new Date().toISOString();
        const target = toTarget(attempt.connection);
        const historyEntry = {
            id: (0, node_crypto_1.randomUUID)(),
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
        }
        catch {
            const message = 'Query history could not be written.';
            warnings.push(message);
            this.reportStorageWarning(`[SUPRA] ${message}`);
        }
        warnings.push(...this.writeAudit({
            id: (0, node_crypto_1.randomUUID)(),
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
    async recordAuditEvent(event) {
        const warnings = this.writeAudit({
            id: (0, node_crypto_1.randomUUID)(),
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
    writeAudit(entry) {
        try {
            this.auditRepository.add({
                ...entry,
                windowsUser: this.identity.getWindowsUser(),
                computerName: this.identity.getComputerName(),
            });
            return [];
        }
        catch {
            const message = 'Audit log could not be written.';
            this.reportStorageWarning(`[SUPRA] ${message}`);
            return [message];
        }
    }
}
exports.LocalQueryActivityService = LocalQueryActivityService;
function toTarget(connection) {
    return {
        profileName: connection?.name ?? null,
        environment: connection?.environment ?? null,
        host: connection?.host ?? null,
        database: connection?.database ?? null,
        databaseUser: connection?.username ?? null,
    };
}
