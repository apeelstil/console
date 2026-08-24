"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresMetadataService = exports.MetadataServiceError = void 0;
exports.getSafeMetadataError = getSafeMetadataError;
const postgresConnectionManager_1 = require("./postgresConnectionManager");
const postgresOperationGate_1 = require("./postgresOperationGate");
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
class MetadataServiceError extends Error {
    safeMessage;
    constructor(safeMessage) {
        super(safeMessage);
        this.safeMessage = safeMessage;
        this.name = 'MetadataServiceError';
    }
}
exports.MetadataServiceError = MetadataServiceError;
class PostgresMetadataService {
    connectionManager;
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
    }
    async listSchemas() {
        const result = await this.query((client) => client.query({
            text: LIST_SCHEMAS_QUERY,
            query_timeout: METADATA_QUERY_TIMEOUT_MS,
        }));
        return result.rows
            .map((row) => ({ name: row.name }))
            .filter((schema) => isUserSchema(schema.name))
            .sort((first, second) => first.name.localeCompare(second.name));
    }
    async listSchemaObjects(schema) {
        const result = await this.query((client) => client.query({
            text: LIST_SCHEMA_OBJECTS_QUERY,
            values: [schema],
            query_timeout: METADATA_QUERY_TIMEOUT_MS,
        }));
        return result.rows
            .map((row) => ({
            schema: row.schema_name,
            name: row.object_name,
            type: mapObjectType(row.table_type),
        }))
            .sort((first, second) => first.name.localeCompare(second.name));
    }
    async listColumns(schema, objectName) {
        const result = await this.query((client) => client.query({
            text: LIST_COLUMNS_QUERY,
            values: [schema, objectName],
            query_timeout: METADATA_QUERY_TIMEOUT_MS,
        }));
        return result.rows
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
    async query(operation) {
        try {
            return await this.connectionManager.withActiveClient(operation);
        }
        catch (error) {
            throw new MetadataServiceError(getSafeMetadataError(error));
        }
    }
}
exports.PostgresMetadataService = PostgresMetadataService;
function isUserSchema(name) {
    return name !== 'information_schema' && name !== 'pg_catalog' && !name.startsWith('pg_');
}
function mapObjectType(tableType) {
    return tableType === 'VIEW' ? 'VIEW' : 'TABLE';
}
function getSafeMetadataError(error) {
    if (error instanceof MetadataServiceError)
        return error.safeMessage;
    if (error instanceof postgresConnectionManager_1.ConnectionManagerError)
        return error.safeMessage;
    if (error instanceof postgresOperationGate_1.PostgresOperationBlockedError)
        return error.safeMessage;
    const details = typeof error === 'object' && error !== null ? error : {};
    const code = typeof details.code === 'string' ? details.code : '';
    const message = typeof details.message === 'string' ? details.message.toLowerCase() : '';
    if (code === '42501')
        return 'Permission denied while loading database metadata.';
    if (code === '57014' || code === 'QUERY_READ_TIMEOUT' || message.includes('query read timeout')) {
        return 'The database metadata query timed out.';
    }
    if (code === '57P01' || code === 'ECONNRESET')
        return 'The database connection was interrupted while loading metadata.';
    return 'Failed to load database metadata.';
}
