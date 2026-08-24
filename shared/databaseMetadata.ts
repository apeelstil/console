import type { IpcResult } from './connectionProfiles';

export interface DatabaseSchema {
  name: string;
}

export type DatabaseObjectType = 'TABLE' | 'VIEW';

export interface DatabaseObject {
  schema: string;
  name: string;
  type: DatabaseObjectType;
}

export interface DatabaseColumn {
  schema: string;
  objectName: string;
  name: string;
  dataType: string;
  nullable: boolean;
  ordinalPosition: number;
  nativeType?: string;
}

export interface PostgresMetadataApi {
  listSchemas: () => Promise<IpcResult<DatabaseSchema[]>>;
  listSchemaObjects: (schema: string) => Promise<IpcResult<DatabaseObject[]>>;
  listColumns: (schema: string, objectName: string) => Promise<IpcResult<DatabaseColumn[]>>;
}

export const POSTGRES_METADATA_CHANNELS = {
  listSchemas: 'postgres-metadata:list-schemas',
  listSchemaObjects: 'postgres-metadata:list-schema-objects',
  listColumns: 'postgres-metadata:list-columns',
} as const;
