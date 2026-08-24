export const PENDING_MUTATION_BLOCK_MESSAGE =
  'An uncommitted mutation transaction is awaiting COMMIT or ROLLBACK.';

export class PostgresOperationBlockedError extends Error {
  constructor(public readonly safeMessage = PENDING_MUTATION_BLOCK_MESSAGE) {
    super(safeMessage);
    this.name = 'PostgresOperationBlockedError';
  }
}

export class PostgresOperationGate {
  private mutationOwnerId: string | undefined;

  reserveForMutation(transactionId: string): void {
    if (this.mutationOwnerId) throw new PostgresOperationBlockedError();
    this.mutationOwnerId = transactionId;
  }

  releaseMutation(transactionId: string): void {
    if (this.mutationOwnerId === transactionId) this.mutationOwnerId = undefined;
  }

  assertStandardOperationAllowed(): void {
    if (this.mutationOwnerId) throw new PostgresOperationBlockedError();
  }

  assertMutationOwner(transactionId: string): void {
    if (this.mutationOwnerId !== transactionId) {
      throw new PostgresOperationBlockedError('The mutation transaction is no longer active.');
    }
  }

  hasPendingMutation(): boolean {
    return this.mutationOwnerId !== undefined;
  }
}
