import type { IpcResult } from './connectionProfiles';
import type { ActiveConnectionInfo } from './postgresConnection';

export const MUTATION_CONFIRMATION_TIMEOUT_MS = 120_000;

export type MutationOperation = 'INSERT' | 'UPDATE';
export type MutationTransactionStatus =
  | 'IDLE'
  | 'EXECUTING'
  | 'PENDING_CONFIRMATION'
  | 'COMMITTING'
  | 'ROLLING_BACK'
  | 'ERROR';

export interface MutationTarget {
  schema: string;
  table: string;
}

export interface PreparedMutation {
  preparationId: string;
  operation: MutationOperation;
  target: MutationTarget;
  sqlText: string;
  connection: ActiveConnectionInfo;
  storageWarnings?: string[];
}

export interface PendingMutationTransaction {
  transactionId: string;
  status: 'PENDING_CONFIRMATION';
  operation: MutationOperation;
  target: MutationTarget;
  affectedRows: number;
  startedAt: string;
  rollbackDeadlineAt: string;
  connection: ActiveConnectionInfo;
  storageWarnings?: string[];
}

export type MutationTransactionState =
  | { status: 'IDLE'; message?: string }
  | { status: 'ERROR'; message: string }
  | {
      status: 'EXECUTING' | 'COMMITTING' | 'ROLLING_BACK';
      transactionId: string;
      operation: MutationOperation;
      target: MutationTarget;
      startedAt: string;
      connection: ActiveConnectionInfo;
    }
  | PendingMutationTransaction;

export interface MutationTransactionApi {
  prepareMutation: (sql: string) => Promise<IpcResult<PreparedMutation>>;
  executeMutation: (preparationId: string) => Promise<IpcResult<PendingMutationTransaction>>;
  commitMutation: (transactionId: string) => Promise<IpcResult<MutationTransactionState>>;
  rollbackMutation: (transactionId: string) => Promise<IpcResult<MutationTransactionState>>;
  getMutationState: () => Promise<IpcResult<MutationTransactionState>>;
  onMutationStateChanged: (listener: (state: MutationTransactionState) => void) => () => void;
}

export const MUTATION_TRANSACTION_CHANNELS = {
  prepare: 'mutation-transaction:prepare',
  execute: 'mutation-transaction:execute',
  commit: 'mutation-transaction:commit',
  rollback: 'mutation-transaction:rollback',
  getState: 'mutation-transaction:get-state',
  stateChanged: 'mutation-transaction:state-changed',
} as const;
