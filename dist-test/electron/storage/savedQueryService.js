"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavedQueryService = exports.SavedQueryServiceError = void 0;
const node_crypto_1 = require("node:crypto");
class SavedQueryServiceError extends Error {
    safeMessage;
    constructor(safeMessage) {
        super(safeMessage);
        this.safeMessage = safeMessage;
        this.name = 'SavedQueryServiceError';
    }
}
exports.SavedQueryServiceError = SavedQueryServiceError;
class SavedQueryService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    listQueries() {
        return this.repository.list();
    }
    createQuery(input) {
        const normalized = normalizeInput(input);
        const timestamp = new Date().toISOString();
        return this.repository.create({
            id: (0, node_crypto_1.randomUUID)(),
            ...normalized,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
    }
    updateQuery(input) {
        const current = this.repository.findById(input.id);
        if (!current)
            throw new SavedQueryServiceError('The selected saved query no longer exists.');
        const normalized = normalizeInput(input);
        return this.repository.update({
            ...current,
            ...normalized,
            updatedAt: new Date().toISOString(),
        });
    }
    deleteQuery(id) {
        if (!this.repository.delete(id)) {
            throw new SavedQueryServiceError('The selected saved query no longer exists.');
        }
    }
}
exports.SavedQueryService = SavedQueryService;
function normalizeInput(input) {
    const name = input.name.trim();
    const sqlText = input.sqlText.trim();
    const description = input.description?.trim() || null;
    if (!name)
        throw new SavedQueryServiceError('Saved query name is required.');
    if (!sqlText)
        throw new SavedQueryServiceError('SQL cannot be empty.');
    return { name, description, sqlText };
}
