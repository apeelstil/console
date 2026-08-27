import type {
  DatabaseColumn,
  DatabaseMetadataSearchResult,
  DatabaseObject,
  DatabaseObjectType,
  DatabaseSchema,
  PostgresMetadataApi,
} from '../shared/databaseMetadata';

export type MetadataLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface MetadataLoadState<T> {
  status: MetadataLoadStatus;
  data: T;
  error?: string;
}

export interface DatabaseExplorerState {
  sessionKey?: string;
  generation: number;
  schemas: MetadataLoadState<DatabaseSchema[]>;
  objectsBySchema: Record<string, MetadataLoadState<DatabaseObject[]>>;
  columnsByObject: Record<string, MetadataLoadState<DatabaseColumn[]>>;
  expandedSchemas: string[];
  expandedGroups: string[];
  expandedObjects: string[];
  selectedObject?: DatabaseObject;
  search: MetadataSearchState;
}

export interface MetadataSearchState extends MetadataLoadState<DatabaseMetadataSearchResult[]> {
  query: string;
}

export interface DatabaseExplorerSelection {
  object: DatabaseObject;
  columns: DatabaseColumn[];
}

type Listener = () => void;
export const DATABASE_SEARCH_DEBOUNCE_MS = 300;
const MAX_SEARCH_TERM_LENGTH = 128;

export class DatabaseExplorerController {
  private generation = 0;
  private searchRequestId = 0;
  private state: DatabaseExplorerState = createExplorerState(this.generation);
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly api: PostgresMetadataApi,
    private readonly searchDebounceMs = DATABASE_SEARCH_DEBOUNCE_MS,
  ) {}

  readonly getSnapshot = (): DatabaseExplorerState => this.state;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async activate(sessionKey: string): Promise<void> {
    const generation = this.nextGeneration();
    this.state = createExplorerState(generation, sessionKey, 'loading');
    this.emit();
    await this.loadSchemas(generation);
  }

  disconnect(): void {
    this.state = createExplorerState(this.nextGeneration());
    this.emit();
  }

  async refresh(): Promise<void> {
    const sessionKey = this.state.sessionKey;
    if (!sessionKey) return;
    const generation = this.nextGeneration();
    this.state = createExplorerState(generation, sessionKey, 'loading');
    this.emit();
    await this.loadSchemas(generation);
  }

  async toggleSchema(schema: string): Promise<void> {
    const key = schemaCacheKey(schema);
    const expanded = this.state.expandedSchemas.includes(key);
    this.state = {
      ...this.state,
      expandedSchemas: toggleKey(this.state.expandedSchemas, key),
    };
    this.emit();

    if (!expanded && !this.state.objectsBySchema[key]) {
      await this.loadSchemaObjects(schema, this.state.generation);
    }
  }

  toggleGroup(schema: string, type: DatabaseObjectType): void {
    const key = groupCacheKey(schema, type);
    this.state = {
      ...this.state,
      expandedGroups: toggleKey(this.state.expandedGroups, key),
    };
    this.emit();
  }

  async selectObject(object: DatabaseObject): Promise<void> {
    const key = objectCacheKey(object.schema, object.name);
    this.state = {
      ...this.state,
      selectedObject: { ...object },
      expandedObjects: toggleKey(this.state.expandedObjects, key),
    };
    this.emit();

    if (!this.state.columnsByObject[key]) {
      await this.loadColumns(object, this.state.generation);
    }
  }

  async searchMetadata(query: string): Promise<void> {
    const requestId = ++this.searchRequestId;
    const generation = this.state.generation;
    const normalizedQuery = query.trim();

    if (!this.state.sessionKey) {
      this.state = { ...this.state, search: emptySearchState() };
      this.emit();
      return;
    }
    if (!normalizedQuery) {
      this.state = { ...this.state, search: emptySearchState() };
      this.emit();
      return;
    }
    if (normalizedQuery.length < 2) {
      this.state = { ...this.state, search: { query, status: 'idle', data: [] } };
      this.emit();
      return;
    }
    if (normalizedQuery.length > MAX_SEARCH_TERM_LENGTH) {
      this.state = {
        ...this.state,
        search: { query, status: 'error', data: [], error: 'Строка поиска не должна превышать 128 символов.' },
      };
      this.emit();
      return;
    }

    this.state = { ...this.state, search: { query, status: 'loading', data: [] } };
    this.emit();
    if (this.searchDebounceMs > 0) await delay(this.searchDebounceMs);
    if (!this.isCurrentSearch(requestId, generation)) return;

    const result = await safelyInvoke(() => this.api.searchDatabaseMetadata(normalizedQuery));
    if (!this.isCurrentSearch(requestId, generation)) return;
    this.state = {
      ...this.state,
      search: result.ok
        ? { query, status: 'loaded', data: result.data.slice(0, 100) }
        : { query, status: 'error', data: [], error: result.error },
    };
    this.emit();
  }

  async revealSearchResult(result: DatabaseMetadataSearchResult): Promise<void> {
    if (!this.state.sessionKey) return;
    const generation = this.state.generation;
    const schemaKey = schemaCacheKey(result.schema);
    this.searchRequestId += 1;
    this.state = {
      ...this.state,
      expandedSchemas: addKey(this.state.expandedSchemas, schemaKey),
    };
    this.emit();

    if (!this.state.objectsBySchema[schemaKey]) {
      await this.loadSchemaObjects(result.schema, generation);
    }
    if (this.state.generation !== generation) return;
    if (result.type === 'SCHEMA') {
      this.clearSearch();
      return;
    }

    const object = this.state.objectsBySchema[schemaKey]?.data.find((candidate) => (
      candidate.name === result.objectName && candidate.type === result.objectType
    ));
    if (!object) {
      this.state = {
        ...this.state,
        search: {
          ...this.state.search,
          status: 'error',
          data: [],
          error: 'Объект больше недоступен. Обновите поиск.',
        },
      };
      this.emit();
      return;
    }

    const groupKey = groupCacheKey(object.schema, object.type);
    const objectKey = objectCacheKey(object.schema, object.name);
    this.state = {
      ...this.state,
      selectedObject: { ...object },
      expandedGroups: addKey(this.state.expandedGroups, groupKey),
      expandedObjects: addKey(this.state.expandedObjects, objectKey),
    };
    this.emit();
    if (!this.state.columnsByObject[objectKey]) await this.loadColumns(object, generation);
    if (this.state.generation === generation) this.clearSearch();
  }

  clearSearch(): void {
    this.searchRequestId += 1;
    this.state = { ...this.state, search: emptySearchState() };
    this.emit();
  }

  async retrySchemas(): Promise<void> {
    if (!this.state.sessionKey) return;
    await this.loadSchemas(this.state.generation);
  }

  async retrySchema(schema: string): Promise<void> {
    await this.loadSchemaObjects(schema, this.state.generation);
  }

  async retryColumns(object: DatabaseObject): Promise<void> {
    await this.loadColumns(object, this.state.generation);
  }

  getSelection(state: DatabaseExplorerState = this.state): DatabaseExplorerSelection | undefined {
    const selected = state.selectedObject;
    if (!selected) return undefined;
    const columns = state.columnsByObject[objectCacheKey(selected.schema, selected.name)]?.data ?? [];
    return { object: { ...selected }, columns: [...columns] };
  }

  private async loadSchemas(generation: number): Promise<void> {
    this.updateForGeneration(generation, (state) => ({
      ...state,
      schemas: loadingState<DatabaseSchema[]>(),
    }));
    const result = await safelyInvoke(() => this.api.listSchemas());
    this.updateForGeneration(generation, (state) => ({
      ...state,
      schemas: result.ok ? loadedState(result.data) : errorState(result.error, []),
    }));
  }

  private async loadSchemaObjects(schema: string, generation: number): Promise<void> {
    const key = schemaCacheKey(schema);
    this.updateForGeneration(generation, (state) => ({
      ...state,
      objectsBySchema: { ...state.objectsBySchema, [key]: loadingState<DatabaseObject[]>() },
    }));
    const result = await safelyInvoke(() => this.api.listSchemaObjects(schema));
    this.updateForGeneration(generation, (state) => ({
      ...state,
      objectsBySchema: {
        ...state.objectsBySchema,
        [key]: result.ok ? loadedState(result.data) : errorState(result.error, []),
      },
    }));
  }

  private async loadColumns(object: DatabaseObject, generation: number): Promise<void> {
    const key = objectCacheKey(object.schema, object.name);
    this.updateForGeneration(generation, (state) => ({
      ...state,
      columnsByObject: { ...state.columnsByObject, [key]: loadingState<DatabaseColumn[]>() },
    }));
    const result = await safelyInvoke(() => this.api.listColumns(object.schema, object.name));
    this.updateForGeneration(generation, (state) => ({
      ...state,
      columnsByObject: {
        ...state.columnsByObject,
        [key]: result.ok ? loadedState(result.data) : errorState(result.error, []),
      },
    }));
  }

  private updateForGeneration(
    generation: number,
    update: (state: DatabaseExplorerState) => DatabaseExplorerState,
  ): void {
    if (this.state.generation !== generation) return;
    this.state = update(this.state);
    this.emit();
  }

  private nextGeneration(): number {
    this.searchRequestId += 1;
    this.generation += 1;
    return this.generation;
  }

  private isCurrentSearch(requestId: number, generation: number): boolean {
    return this.searchRequestId === requestId
      && this.state.generation === generation
      && Boolean(this.state.sessionKey);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function schemaCacheKey(schema: string): string {
  return JSON.stringify(schema);
}

export function groupCacheKey(schema: string, type: DatabaseObjectType): string {
  return JSON.stringify([schema, type]);
}

export function objectCacheKey(schema: string, objectName: string): string {
  return JSON.stringify([schema, objectName]);
}

function createExplorerState(
  generation: number,
  sessionKey?: string,
  schemaStatus: MetadataLoadStatus = 'idle',
): DatabaseExplorerState {
  return {
    ...(sessionKey ? { sessionKey } : {}),
    generation,
    schemas: { status: schemaStatus, data: [] },
    objectsBySchema: {},
    columnsByObject: {},
    expandedSchemas: [],
    expandedGroups: [],
    expandedObjects: [],
    search: emptySearchState(),
  };
}

function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

function addKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys : [...keys, key];
}

function loadingState<T>(): MetadataLoadState<T> {
  return { status: 'loading', data: [] as T };
}

function loadedState<T>(data: T): MetadataLoadState<T> {
  return { status: 'loaded', data };
}

function errorState<T>(error: string, data: T): MetadataLoadState<T> {
  return { status: 'error', data, error };
}

async function safelyInvoke<T>(operation: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
  try {
    return await operation();
  } catch {
    return { ok: false as const, error: 'Служба метаданных базы данных не отвечает.' };
  }
}

function emptySearchState(): MetadataSearchState {
  return { query: '', status: 'idle', data: [] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
