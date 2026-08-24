"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresOperationGate = exports.PostgresOperationBlockedError = exports.PENDING_MUTATION_BLOCK_MESSAGE = void 0;
exports.PENDING_MUTATION_BLOCK_MESSAGE = 'An uncommitted mutation transaction is awaiting COMMIT or ROLLBACK.';
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
    reserveForMutation(transactionId) {
        if (this.mutationOwnerId)
            throw new PostgresOperationBlockedError();
        this.mutationOwnerId = transactionId;
    }
    releaseMutation(transactionId) {
        if (this.mutationOwnerId === transactionId)
            this.mutationOwnerId = undefined;
    }
    assertStandardOperationAllowed() {
        if (this.mutationOwnerId)
            throw new PostgresOperationBlockedError();
    }
    assertMutationOwner(transactionId) {
        if (this.mutationOwnerId !== transactionId) {
            throw new PostgresOperationBlockedError('The mutation transaction is no longer active.');
        }
    }
    hasPendingMutation() {
        return this.mutationOwnerId !== undefined;
    }
}
exports.PostgresOperationGate = PostgresOperationGate;
