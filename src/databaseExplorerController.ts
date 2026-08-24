import type {
  DatabaseColumn,
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
}

export interface DatabaseExplorerSelection {
  object: DatabaseObject;
  columns: DatabaseColumn[];
}

type Listener = () => void;

export class DatabaseExplorerController {
  private generation = 0;
  private state: DatabaseExplorerState = createExplorerState(this.generation);
  private readonly listeners = new Set<Listener>();

  constructor(private readonly api: PostgresMetadataApi) {}

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
    this.generation += 1;
    return this.generation;
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
  };
}

function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
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
    return { ok: false as const, error: 'Database metadata service did not respond.' };
  }
}
