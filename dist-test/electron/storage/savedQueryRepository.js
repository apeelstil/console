"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavedQueryRepository = void 0;
const savedQueryColumns = 'id, name, description, sql_text, created_at, updated_at';
class SavedQueryRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    list() {
        return this.database
            .prepare(`
        SELECT ${savedQueryColumns}
        FROM saved_queries
        ORDER BY updated_at DESC, lower(name)
      `)
            .all()
            .map(mapSavedQuery);
    }
    findById(id) {
        const row = this.database
            .prepare(`
        SELECT ${savedQueryColumns}
        FROM saved_queries
        WHERE id = ?
      `)
            .get(id);
        return row ? mapSavedQuery(row) : undefined;
    }
    create(query) {
        this.database.prepare(`
      INSERT INTO saved_queries (
        id, name, description, sql_text, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @sqlText, @createdAt, @updatedAt
      )
    `).run(toParameters(query));
        return query;
    }
    update(query) {
        const result = this.database.prepare(`
      UPDATE saved_queries
      SET name = @name,
          description = @description,
          sql_text = @sqlText,
          updated_at = @updatedAt
      WHERE id = @id
    `).run(toParameters(query));
        if (result.changes !== 1)
            throw new Error('Saved query was not found.');
        return query;
    }
    delete(id) {
        return this.database
            .prepare('DELETE FROM saved_queries WHERE id = ?')
            .run(id).changes === 1;
    }
}
exports.SavedQueryRepository = SavedQueryRepository;
function mapSavedQuery(row) {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        sqlText: row.sql_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function toParameters(query) {
    return {
        id: query.id,
        name: query.name,
        description: query.description,
        sqlText: query.sqlText,
        createdAt: query.createdAt,
        updatedAt: query.updatedAt,
    };
}
