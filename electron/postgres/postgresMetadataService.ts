import type {
  DatabaseColumn,
  DatabaseMetadataSearchResult,
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
export const DATABASE_METADATA_SEARCH_LIMIT = 100;

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

const SEARCH_DATABASE_METADATA_QUERY = `
  WITH metadata_matches AS (
    SELECT
      'SCHEMA'::text AS result_type,
      schema_name,
      NULL::text AS object_name,
      NULL::text AS object_type,
      NULL::text AS column_name,
      NULL::text AS data_type,
      NULL::text AS udt_name
    FROM information_schema.schemata
    WHERE schema_name <> 'information_schema'
      AND schema_name <> 'pg_catalog'
      AND left(schema_name, 3) <> 'pg_'
      AND strpos(lower(schema_name), lower($1)) > 0

    UNION ALL

    SELECT
      CASE WHEN table_type = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END,
      table_schema,
      table_name,
      table_type,
      NULL::text,
      NULL::text,
      NULL::text
    FROM information_schema.tables
    WHERE table_schema <> 'information_schema'
      AND table_schema <> 'pg_catalog'
      AND left(table_schema, 3) <> 'pg_'
      AND table_type IN ('BASE TABLE', 'VIEW')
      AND strpos(lower(table_name), lower($1)) > 0

    UNION ALL

    SELECT
      'COLUMN'::text,
      columns.table_schema,
      columns.table_name,
      tables.table_type,
      columns.column_name,
      columns.data_type,
      columns.udt_name
    FROM information_schema.columns AS columns
    INNER JOIN information_schema.tables AS tables
      ON tables.table_schema = columns.table_schema
      AND tables.table_name = columns.table_name
      AND tables.table_type IN ('BASE TABLE', 'VIEW')
    WHERE columns.table_schema <> 'information_schema'
      AND columns.table_schema <> 'pg_catalog'
      AND left(columns.table_schema, 3) <> 'pg_'
      AND strpos(lower(columns.column_name), lower($1)) > 0
  )
  SELECT result_type, schema_name, object_name, object_type, column_name, data_type, udt_name
  FROM metadata_matches
  ORDER BY schema_name, object_name NULLS FIRST, column_name NULLS FIRST, result_type
  LIMIT 100
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

interface SearchRow {
  result_type: 'SCHEMA' | 'TABLE' | 'VIEW' | 'COLUMN';
  schema_name: string;
  object_name: string | null;
  object_type: 'BASE TABLE' | 'VIEW' | null;
  column_name: string | null;
  data_type: string | null;
  udt_name: string | null;
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

  async searchDatabaseMetadata(term: string): Promise<DatabaseMetadataSearchResult[]> {
    const normalizedTerm = term.trim();
    if (normalizedTerm.length < 2) return [];

    const result = await this.query((client) => client.query({
      text: SEARCH_DATABASE_METADATA_QUERY,
      values: [normalizedTerm],
      query_timeout: METADATA_QUERY_TIMEOUT_MS,
    }));

    return (result.rows as SearchRow[])
      .filter((row) => isUserSchema(row.schema_name))
      .map(mapSearchResult)
      .slice(0, DATABASE_METADATA_SEARCH_LIMIT);
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

function mapSearchResult(row: SearchRow): DatabaseMetadataSearchResult {
  if (row.result_type === 'SCHEMA') return { type: 'SCHEMA', schema: row.schema_name };
  const objectType = row.object_type === 'VIEW' ? 'VIEW' : 'TABLE';
  if (row.result_type === 'COLUMN') {
    return {
      type: 'COLUMN',
      schema: row.schema_name,
      objectName: row.object_name ?? '',
      objectType,
      columnName: row.column_name ?? '',
      dataType: row.data_type ?? '',
      ...(row.udt_name ? { nativeType: row.udt_name } : {}),
    };
  }
  return {
    type: objectType,
    schema: row.schema_name,
    objectName: row.object_name ?? '',
    objectType,
  };
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

  if (code === '42501') return 'Недостаточно прав для загрузки метаданных базы данных.';
  if (code === '57014' || code === 'QUERY_READ_TIMEOUT' || message.includes('query read timeout')) {
    return 'Превышено время загрузки метаданных базы данных.';
  }
  if (code === '57P01' || code === 'ECONNRESET') return 'Подключение к базе данных прервано во время загрузки метаданных.';
  return 'Не удалось загрузить метаданные базы данных.';
}
