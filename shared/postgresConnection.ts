import type { ConnectionProfileFields, IpcResult } from './connectionProfiles';

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'TESTING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'ERROR';

export interface ActiveConnectionInfo extends ConnectionProfileFields {
  profileId?: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  connection?: ActiveConnectionInfo;
  message?: string;
}

export type ConnectionRequest =
  | {
      source: 'profile';
      profileId: string;
      temporaryPassword: string;
    }
  | {
      source: 'temporary';
      connection: ConnectionProfileFields;
      temporaryPassword: string;
    };

export interface ConnectionTestResult {
  message: 'Подключение успешно';
  durationMs: number;
}

export interface PostgresConnectionApi {
  testConnection: (request: ConnectionRequest) => Promise<IpcResult<ConnectionTestResult>>;
  connect: (request: ConnectionRequest) => Promise<IpcResult<ConnectionState>>;
  disconnect: () => Promise<IpcResult<ConnectionState>>;
  getConnectionState: () => Promise<IpcResult<ConnectionState>>;
  onConnectionStateChanged: (listener: (state: ConnectionState) => void) => () => void;
}

export const POSTGRES_CONNECTION_CHANNELS = {
  test: 'postgres-connection:test',
  connect: 'postgres-connection:connect',
  disconnect: 'postgres-connection:disconnect',
  getState: 'postgres-connection:get-state',
  stateChanged: 'postgres-connection:state-changed',
} as const;
