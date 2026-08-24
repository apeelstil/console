import type { PostgresMetadataApi } from './databaseMetadata';
import type { PostgresConnectionApi } from './postgresConnection';
import type { SelectQueryExecutionApi } from './queryExecution';
import type { LocalQueryDataApi } from './localQueryData';
import type { MutationTransactionApi } from './mutationTransaction';

export const CONNECTION_ENVIRONMENTS = ['PROD', 'TEST', 'DEV', 'OTHER'] as const;

export type ConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

export interface ConnectionProfileFields {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  environment: ConnectionEnvironment;
}

export interface ConnectionProfile extends ConnectionProfileFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateConnectionProfileInput = ConnectionProfileFields;

export interface UpdateConnectionProfileInput extends ConnectionProfileFields {
  id: string;
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface SupraDesktopApi extends PostgresConnectionApi, PostgresMetadataApi, SelectQueryExecutionApi, LocalQueryDataApi, MutationTransactionApi {
  getPlatform: () => Promise<string>;
  listProfiles: () => Promise<IpcResult<ConnectionProfile[]>>;
  createProfile: (input: CreateConnectionProfileInput) => Promise<IpcResult<ConnectionProfile>>;
  updateProfile: (input: UpdateConnectionProfileInput) => Promise<IpcResult<ConnectionProfile>>;
  deleteProfile: (id: string) => Promise<IpcResult<{ id: string }>>;
}

export const CONNECTION_PROFILE_CHANNELS = {
  list: 'connection-profiles:list',
  create: 'connection-profiles:create',
  update: 'connection-profiles:update',
  delete: 'connection-profiles:delete',
} as const;

export function isConnectionEnvironment(value: unknown): value is ConnectionEnvironment {
  return typeof value === 'string' && CONNECTION_ENVIRONMENTS.includes(value as ConnectionEnvironment);
}

export function isProductionEnvironment(environment: ConnectionEnvironment): boolean {
  return environment === 'PROD';
}
