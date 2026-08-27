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

export type DatabaseMetadataSearchResultType = 'SCHEMA' | 'TABLE' | 'VIEW' | 'COLUMN';

export interface DatabaseMetadataSearchResult {
  type: DatabaseMetadataSearchResultType;
  schema: string;
  objectName?: string;
  objectType?: DatabaseObjectType;
  columnName?: string;
  dataType?: string;
  nativeType?: string;
}

export interface PostgresMetadataApi {
  listSchemas: () => Promise<IpcResult<DatabaseSchema[]>>;
  listSchemaObjects: (schema: string) => Promise<IpcResult<DatabaseObject[]>>;
  listColumns: (schema: string, objectName: string) => Promise<IpcResult<DatabaseColumn[]>>;
  searchDatabaseMetadata: (term: string) => Promise<IpcResult<DatabaseMetadataSearchResult[]>>;
}

export const POSTGRES_METADATA_CHANNELS = {
  listSchemas: 'postgres-metadata:list-schemas',
  listSchemaObjects: 'postgres-metadata:list-schema-objects',
  listColumns: 'postgres-metadata:list-columns',
  searchDatabaseMetadata: 'postgres-metadata:search',
} as const;
