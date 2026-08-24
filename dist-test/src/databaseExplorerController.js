"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseExplorerController = void 0;
exports.schemaCacheKey = schemaCacheKey;
exports.groupCacheKey = groupCacheKey;
exports.objectCacheKey = objectCacheKey;
class DatabaseExplorerController {
    api;
    generation = 0;
    state = createExplorerState(this.generation);
    listeners = new Set();
    constructor(api) {
        this.api = api;
    }
    getSnapshot = () => this.state;
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    async activate(sessionKey) {
        const generation = this.nextGeneration();
        this.state = createExplorerState(generation, sessionKey, 'loading');
        this.emit();
        await this.loadSchemas(generation);
    }
    disconnect() {
        this.state = createExplorerState(this.nextGeneration());
        this.emit();
    }
    async refresh() {
        const sessionKey = this.state.sessionKey;
        if (!sessionKey)
            return;
        const generation = this.nextGeneration();
        this.state = createExplorerState(generation, sessionKey, 'loading');
        this.emit();
        await this.loadSchemas(generation);
    }
    async toggleSchema(schema) {
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
    toggleGroup(schema, type) {
        const key = groupCacheKey(schema, type);
        this.state = {
            ...this.state,
            expandedGroups: toggleKey(this.state.expandedGroups, key),
        };
        this.emit();
    }
    async selectObject(object) {
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
    async retrySchemas() {
        if (!this.state.sessionKey)
            return;
        await this.loadSchemas(this.state.generation);
    }
    async retrySchema(schema) {
        await this.loadSchemaObjects(schema, this.state.generation);
    }
    async retryColumns(object) {
        await this.loadColumns(object, this.state.generation);
    }
    getSelection(state = this.state) {
        const selected = state.selectedObject;
        if (!selected)
            return undefined;
        const columns = state.columnsByObject[objectCacheKey(selected.schema, selected.name)]?.data ?? [];
        return { object: { ...selected }, columns: [...columns] };
    }
    async loadSchemas(generation) {
        this.updateForGeneration(generation, (state) => ({
            ...state,
            schemas: loadingState(),
        }));
        const result = await safelyInvoke(() => this.api.listSchemas());
        this.updateForGeneration(generation, (state) => ({
            ...state,
            schemas: result.ok ? loadedState(result.data) : errorState(result.error, []),
        }));
    }
    async loadSchemaObjects(schema, generation) {
        const key = schemaCacheKey(schema);
        this.updateForGeneration(generation, (state) => ({
            ...state,
            objectsBySchema: { ...state.objectsBySchema, [key]: loadingState() },
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
    async loadColumns(object, generation) {
        const key = objectCacheKey(object.schema, object.name);
        this.updateForGeneration(generation, (state) => ({
            ...state,
            columnsByObject: { ...state.columnsByObject, [key]: loadingState() },
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
    updateForGeneration(generation, update) {
        if (this.state.generation !== generation)
            return;
        this.state = update(this.state);
        this.emit();
    }
    nextGeneration() {
        this.generation += 1;
        return this.generation;
    }
    emit() {
        for (const listener of this.listeners)
            listener();
    }
}
exports.DatabaseExplorerController = DatabaseExplorerController;
function schemaCacheKey(schema) {
    return JSON.stringify(schema);
}
function groupCacheKey(schema, type) {
    return JSON.stringify([schema, type]);
}
function objectCacheKey(schema, objectName) {
    return JSON.stringify([schema, objectName]);
}
function createExplorerState(generation, sessionKey, schemaStatus = 'idle') {
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
function toggleKey(keys, key) {
    return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}
function loadingState() {
    return { status: 'loading', data: [] };
}
function loadedState(data) {
    return { status: 'loaded', data };
}
function errorState(error, data) {
    return { status: 'error', data, error };
}
async function safelyInvoke(operation) {
    try {
        return await operation();
    }
    catch {
        return { ok: false, error: 'Database metadata service did not respond.' };
    }
}
