import type {
  DatabaseColumn,
  DatabaseObject,
  DatabaseObjectType,
  DatabaseSchema,
} from '../../shared/databaseMetadata';
import {
  ConnectionManagerError,
  type PostgresClient,
  type PostgresQueryResult,
} from './postgresConnectionManager';
import { PostgresOperationBlockedError } from './postgresOperationGate';

const METADATA_QUERY_TIMEOUT_MS = 10_000;

const LIST_SCHEMAS_QUERY = `
  SELECT schema_name AS name
  FROM information_schema.schemata
  WHERE schema_name <> 'information_schema'
    AND schema_name <> 'pg_catalog'
    AND left(schema_name, 3) <> 'pg_'
  ORDER BY schema_name
`;

const LIST_SCHEMA_OBJECTS_QUERY = `
  SELECT
    table_schema AS schema_name,
    table_name AS object_name,
    table_type
  FROM information_schema.tables
  WHERE table_schema = $1
    AND table_type IN ('BASE TABLE', 'VIEW')
  ORDER BY table_type, table_name
`;

const LIST_COLUMNS_QUERY = `
  SELECT
    table_schema AS schema_name,
    table_name AS object_name,
    column_name,
    data_type,
    is_nullable,
    ordinal_position,
    udt_name
  FROM information_schema.columns
  WHERE table_schema = $1
    AND table_name = $2
  ORDER BY ordinal_position
`;

interface SchemaRow {
  name: string;
}

interface ObjectRow {
  schema_name: string;
  object_name: string;
  table_type: 'BASE TABLE' | 'VIEW';
}

interface ColumnRow {
  schema_name: string;
  object_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  ordinal_position: number;
  udt_name: string;
}

export interface ActiveClientProvider {
  /** Active-client callbacks are serialized by the connection manager. */
  withActiveClient<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T>;
}

export class MetadataServiceError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'MetadataServiceError';
  }
}

export class PostgresMetadataService {
  constructor(private readonly connectionManager: ActiveClientProvider) {}

  async listSchemas(): Promise<DatabaseSchema[]> {
    const result = await this.query((client) => client.query({
      text: LIST_SCHEMAS_QUERY,
      query_timeout: METADATA_QUERY_TIMEOUT_MS,
    }));

    return (result.rows as SchemaRow[])
      .map((row) => ({ name: row.name }))
      .filter((schema) => isUserSchema(schema.name))
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  async listSchemaObjects(schema: string): Promise<DatabaseObject[]> {
    const result = await this.query((client) => client.query({
      text: LIST_SCHEMA_OBJECTS_QUERY,
      values: [schema],
      query_timeout: METADATA_QUERY_TIMEOUT_MS,
    }));

    return (result.rows as ObjectRow[])
      .map((row) => ({
        schema: row.schema_name,
        name: row.object_name,
        type: mapObjectType(row.table_type),
      }))
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  async listColumns(schema: string, objectName: string): Promise<DatabaseColumn[]> {
    const result = await this.query((client) => client.query({
      text: LIST_COLUMNS_QUERY,
      values: [schema, objectName],
      query_timeout: METADATA_QUERY_TIMEOUT_MS,
    }));

    return (result.rows as ColumnRow[])
      .map((row) => ({
        schema: row.schema_name,
        objectName: row.object_name,
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable === 'YES',
        ordinalPosition: row.ordinal_position,
        ...(row.udt_name ? { nativeType: row.udt_name } : {}),
      }))
      .sort((first, second) => first.ordinalPosition - second.ordinalPosition);
  }

  private async query(
    operation: (client: PostgresClient) => Promise<PostgresQueryResult>,
  ): Promise<PostgresQueryResult> {
    try {
      return await this.connectionManager.withActiveClient(operation);
    } catch (error: unknown) {
      throw new MetadataServiceError(getSafeMetadataError(error));
    }
  }
}

function isUserSchema(name: string): boolean {
  return name !== 'information_schema' && name !== 'pg_catalog' && !name.startsWith('pg_');
}

function mapObjectType(tableType: ObjectRow['table_type']): DatabaseObjectType {
  return tableType === 'VIEW' ? 'VIEW' : 'TABLE';
}

interface MetadataErrorShape {
  code?: unknown;
  message?: unknown;
}

export function getSafeMetadataError(error: unknown): string {
  if (error instanceof MetadataServiceError) return error.safeMessage;
  if (error instanceof ConnectionManagerError) return error.safeMessage;
  if (error instanceof PostgresOperationBlockedError) return error.safeMessage;

  const details = typeof error === 'object' && error !== null ? error as MetadataErrorShape : {};
  const code = typeof details.code === 'string' ? details.code : '';
  const message = typeof details.message === 'string' ? details.message.toLowerCase() : '';

  if (code === '42501') return 'Permission denied while loading database metadata.';
  if (code === '57014' || code === 'QUERY_READ_TIMEOUT' || message.includes('query read timeout')) {
    return 'The database metadata query timed out.';
  }
  if (code === '57P01' || code === 'ECONNRESET') return 'The database connection was interrupted while loading metadata.';
  return 'Failed to load database metadata.';
}
