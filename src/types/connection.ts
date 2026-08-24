import type { ConnectionEnvironment } from '../../shared/connectionProfiles';

export type { ConnectionEnvironment } from '../../shared/connectionProfiles';

export interface ConnectionDraft {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  environment: ConnectionEnvironment;
  saveProfile: boolean;
  savePasswordSecurely: boolean;
}
