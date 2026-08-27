import { ipcMain } from 'electron';
import type { IpcResult } from '../../shared/connectionProfiles';
import { POSTGRES_METADATA_CHANNELS } from '../../shared/databaseMetadata';
import {
  MetadataServiceError,
  type PostgresMetadataService,
} from '../postgres/postgresMetadataService';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SEARCH_TERM_LENGTH = 128;
type MetadataServiceProvider = () => PostgresMetadataService | undefined;

export function registerPostgresMetadataHandlers(getService: MetadataServiceProvider): void {
  ipcMain.handle(POSTGRES_METADATA_CHANNELS.listSchemas, () =>
    respond(getService, (service) => service.listSchemas()));

  ipcMain.handle(POSTGRES_METADATA_CHANNELS.listSchemaObjects, (_event, schema: unknown) =>
    respond(getService, (service) => service.listSchemaObjects(parseIdentifier(schema, 'schema'))));

  ipcMain.handle(
    POSTGRES_METADATA_CHANNELS.listColumns,
    (_event, schema: unknown, objectName: unknown) => respond(
      getService,
      (service) => service.listColumns(
        parseIdentifier(schema, 'schema'),
        parseIdentifier(objectName, 'database object'),
      ),
    ),
  );

  ipcMain.handle(POSTGRES_METADATA_CHANNELS.searchDatabaseMetadata, (_event, term: unknown) =>
    respond(getService, (service) => service.searchDatabaseMetadata(parseSearchTerm(term))));
}

async function respond<T>(
  getService: MetadataServiceProvider,
  operation: (service: PostgresMetadataService) => Promise<T>,
): Promise<IpcResult<T>> {
  try {
    const service = getService();
    if (!service) return { ok: false, error: 'Просмотр метаданных базы данных недоступен.' };
    return { ok: true, data: await operation(service) };
  } catch (error: unknown) {
    if (error instanceof MetadataServiceError) return { ok: false, error: error.safeMessage };
    return { ok: false, error: 'Не удалось загрузить метаданные базы данных.' };
  }
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new MetadataServiceError(`Invalid ${label} name.`);
  }
  return value;
}

function parseSearchTerm(value: unknown): string {
  if (typeof value !== 'string') throw new MetadataServiceError('Некорректная строка поиска.');
  const term = value.trim();
  if (term.length < 2 || term.length > MAX_SEARCH_TERM_LENGTH) {
    throw new MetadataServiceError('Введите от 2 до 128 символов для поиска.');
  }
  return term;
}
