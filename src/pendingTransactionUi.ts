import {
  MUTATION_CONFIRMATION_TIMEOUT_MS,
  type PendingMutationTransaction,
} from '../shared/mutationTransaction';

export interface PendingTransactionSummary {
  transactionId: string;
  operation: PendingMutationTransaction['operation'];
  table: string;
  affectedRows: number;
  remainingSeconds: number;
}

export function getPendingTransactionSummary(
  transaction: PendingMutationTransaction,
  nowMs = Date.now(),
): PendingTransactionSummary {
  const deadlineMs = Date.parse(transaction.rollbackDeadlineAt);
  const remainingMs = Number.isFinite(deadlineMs)
    ? deadlineMs - nowMs
    : MUTATION_CONFIRMATION_TIMEOUT_MS;
  return {
    transactionId: transaction.transactionId,
    operation: transaction.operation,
    table: `${transaction.target.schema}.${transaction.target.table}`,
    affectedRows: transaction.affectedRows,
    remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
  };
}
