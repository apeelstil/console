export const PENDING_MUTATION_BLOCK_MESSAGE =
  'Незафиксированная транзакция ожидает COMMIT или ROLLBACK.';
export const ACTIVE_SELECT_BLOCK_MESSAGE = 'Выполняется запрос SELECT.';

export class PostgresOperationBlockedError extends Error {
  constructor(public readonly safeMessage = PENDING_MUTATION_BLOCK_MESSAGE) {
    super(safeMessage);
    this.name = 'PostgresOperationBlockedError';
  }
}

export class PostgresOperationGate {
  private mutationOwnerId: string | undefined;
  private selectOwnerId: string | undefined;

  reserveForMutation(transactionId: string): void {
    if (this.mutationOwnerId) throw new PostgresOperationBlockedError();
    if (this.selectOwnerId) throw new PostgresOperationBlockedError(ACTIVE_SELECT_BLOCK_MESSAGE);
    this.mutationOwnerId = transactionId;
  }

  releaseMutation(transactionId: string): void {
    if (this.mutationOwnerId === transactionId) this.mutationOwnerId = undefined;
  }

  assertStandardOperationAllowed(): void {
    if (this.mutationOwnerId) throw new PostgresOperationBlockedError();
    if (this.selectOwnerId) throw new PostgresOperationBlockedError(ACTIVE_SELECT_BLOCK_MESSAGE);
  }

  assertMutationOwner(transactionId: string): void {
    if (this.mutationOwnerId !== transactionId) {
      throw new PostgresOperationBlockedError('Транзакция изменения больше не активна.');
    }
  }

  hasPendingMutation(): boolean {
    return this.mutationOwnerId !== undefined;
  }

  reserveForSelect(operationId: string): void {
    if (this.mutationOwnerId) throw new PostgresOperationBlockedError();
    if (this.selectOwnerId) throw new PostgresOperationBlockedError(ACTIVE_SELECT_BLOCK_MESSAGE);
    this.selectOwnerId = operationId;
  }

  releaseSelect(operationId: string): void {
    if (this.selectOwnerId === operationId) this.selectOwnerId = undefined;
  }

  assertSelectOwner(operationId: string): void {
    if (this.selectOwnerId !== operationId) {
      throw new PostgresOperationBlockedError('Операция SELECT больше не активна.');
    }
  }

  hasActiveSelect(): boolean {
    return this.selectOwnerId !== undefined;
  }
}
