"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresOperationGate = exports.PostgresOperationBlockedError = exports.ACTIVE_SELECT_BLOCK_MESSAGE = exports.PENDING_MUTATION_BLOCK_MESSAGE = void 0;
exports.PENDING_MUTATION_BLOCK_MESSAGE = 'An uncommitted mutation transaction is awaiting COMMIT or ROLLBACK.';
exports.ACTIVE_SELECT_BLOCK_MESSAGE = 'A SELECT query is currently executing.';
class PostgresOperationBlockedError extends Error {
    safeMessage;
    constructor(safeMessage = exports.PENDING_MUTATION_BLOCK_MESSAGE) {
        super(safeMessage);
        this.safeMessage = safeMessage;
        this.name = 'PostgresOperationBlockedError';
    }
}
exports.PostgresOperationBlockedError = PostgresOperationBlockedError;
class PostgresOperationGate {
    mutationOwnerId;
    selectOwnerId;
    reserveForMutation(transactionId) {
        if (this.mutationOwnerId)
            throw new PostgresOperationBlockedError();
        if (this.selectOwnerId)
            throw new PostgresOperationBlockedError(exports.ACTIVE_SELECT_BLOCK_MESSAGE);
        this.mutationOwnerId = transactionId;
    }
    releaseMutation(transactionId) {
        if (this.mutationOwnerId === transactionId)
            this.mutationOwnerId = undefined;
    }
    assertStandardOperationAllowed() {
        if (this.mutationOwnerId)
            throw new PostgresOperationBlockedError();
        if (this.selectOwnerId)
            throw new PostgresOperationBlockedError(exports.ACTIVE_SELECT_BLOCK_MESSAGE);
    }
    assertMutationOwner(transactionId) {
        if (this.mutationOwnerId !== transactionId) {
            throw new PostgresOperationBlockedError('The mutation transaction is no longer active.');
        }
    }
    hasPendingMutation() {
        return this.mutationOwnerId !== undefined;
    }
    reserveForSelect(operationId) {
        if (this.mutationOwnerId)
            throw new PostgresOperationBlockedError();
        if (this.selectOwnerId)
            throw new PostgresOperationBlockedError(exports.ACTIVE_SELECT_BLOCK_MESSAGE);
        this.selectOwnerId = operationId;
    }
    releaseSelect(operationId) {
        if (this.selectOwnerId === operationId)
            this.selectOwnerId = undefined;
    }
    assertSelectOwner(operationId) {
        if (this.selectOwnerId !== operationId) {
            throw new PostgresOperationBlockedError('The SELECT operation is no longer active.');
        }
    }
    hasActiveSelect() {
        return this.selectOwnerId !== undefined;
    }
}
exports.PostgresOperationGate = PostgresOperationGate;
