import { ipcMain } from 'electron';
import type { IpcResult } from '../../shared/connectionProfiles';
import {
  MUTATION_TRANSACTION_CHANNELS,
  type MutationTransactionState,
  type PendingMutationTransaction,
  type PreparedMutation,
} from '../../shared/mutationTransaction';
import {
  MutationTransactionError,
  type MutationTransactionManager,
} from '../postgres/mutationTransactionManager';

type MutationManagerProvider = () => MutationTransactionManager | undefined;

export function registerMutationTransactionHandlers(getManager: MutationManagerProvider): void {
  ipcMain.handle(MUTATION_TRANSACTION_CHANNELS.prepare, (_event, sql: unknown) =>
    respond(getManager, (manager) => manager.prepareMutation(parseSql(sql))));
  ipcMain.handle(MUTATION_TRANSACTION_CHANNELS.execute, (_event, preparationId: unknown) =>
    respond(getManager, (manager) => manager.executeMutation(parseId(preparationId))));
  ipcMain.handle(MUTATION_TRANSACTION_CHANNELS.commit, (_event, transactionId: unknown) =>
    respond(getManager, (manager) => manager.commit(parseId(transactionId))));
  ipcMain.handle(MUTATION_TRANSACTION_CHANNELS.rollback, (_event, transactionId: unknown) =>
    respond(getManager, (manager) => manager.rollback(parseId(transactionId))));
  ipcMain.handle(MUTATION_TRANSACTION_CHANNELS.getState, () =>
    respond(getManager, (manager) => manager.getState()));
}

async function respond<T extends PreparedMutation | PendingMutationTransaction | MutationTransactionState>(
  getManager: MutationManagerProvider,
  operation: (manager: MutationTransactionManager) => T | Promise<T>,
): Promise<IpcResult<T>> {
  try {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Mutation transaction management is unavailable.' };
    return { ok: true, data: await operation(manager) };
  } catch (error: unknown) {
    if (error instanceof MutationTransactionError) return { ok: false, error: error.safeMessage };
    return { ok: false, error: 'The mutation transaction operation could not be completed.' };
  }
}

function parseSql(value: unknown): string {
  if (typeof value !== 'string') throw new MutationTransactionError('Mutation SQL must be a string.');
  return value;
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MutationTransactionError('Invalid mutation transaction identifier.');
  }
  return value;
}
