import type Database from 'better-sqlite3';
import type { SavedQuery } from '../../shared/localQueryData';

interface SavedQueryRow {
  id: string;
  name: string;
  description: string | null;
  sql_text: string;
  created_at: string;
  updated_at: string;
}

interface SavedQueryParameters {
  id: string;
  name: string;
  description: string | null;
  sqlText: string;
  createdAt: string;
  updatedAt: string;
}

const savedQueryColumns = 'id, name, description, sql_text, created_at, updated_at';

export class SavedQueryRepository {
  constructor(private readonly database: Database.Database) {}

  list(): SavedQuery[] {
    return this.database
      .prepare<[], SavedQueryRow>(`
        SELECT ${savedQueryColumns}
        FROM saved_queries
        ORDER BY updated_at DESC, lower(name)
      `)
      .all()
      .map(mapSavedQuery);
  }

  findById(id: string): SavedQuery | undefined {
    const row = this.database
      .prepare<[string], SavedQueryRow>(`
        SELECT ${savedQueryColumns}
        FROM saved_queries
        WHERE id = ?
      `)
      .get(id);
    return row ? mapSavedQuery(row) : undefined;
  }

  create(query: SavedQuery): SavedQuery {
    this.database.prepare<SavedQueryParameters>(`
      INSERT INTO saved_queries (
        id, name, description, sql_text, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @sqlText, @createdAt, @updatedAt
      )
    `).run(toParameters(query));
    return query;
  }

  update(query: SavedQuery): SavedQuery {
    const result = this.database.prepare<SavedQueryParameters>(`
      UPDATE saved_queries
      SET name = @name,
          description = @description,
          sql_text = @sqlText,
          updated_at = @updatedAt
      WHERE id = @id
    `).run(toParameters(query));
    if (result.changes !== 1) throw new Error('Saved query was not found.');
    return query;
  }

  delete(id: string): boolean {
    return this.database
      .prepare<[string]>('DELETE FROM saved_queries WHERE id = ?')
      .run(id).changes === 1;
  }
}

function mapSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sqlText: row.sql_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toParameters(query: SavedQuery): SavedQueryParameters {
  return {
    id: query.id,
    name: query.name,
    description: query.description,
    sqlText: query.sqlText,
    createdAt: query.createdAt,
    updatedAt: query.updatedAt,
  };
}
