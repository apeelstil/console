import { randomUUID } from 'node:crypto';
import type {
  CreateSavedQueryInput,
  SavedQuery,
  UpdateSavedQueryInput,
} from '../../shared/localQueryData';
import type { SavedQueryRepository } from './savedQueryRepository';

export class SavedQueryServiceError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'SavedQueryServiceError';
  }
}

export class SavedQueryService {
  constructor(private readonly repository: SavedQueryRepository) {}

  listQueries(): SavedQuery[] {
    return this.repository.list();
  }

  createQuery(input: CreateSavedQueryInput): SavedQuery {
    const normalized = normalizeInput(input);
    const timestamp = new Date().toISOString();
    return this.repository.create({
      id: randomUUID(),
      ...normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  updateQuery(input: UpdateSavedQueryInput): SavedQuery {
    const current = this.repository.findById(input.id);
    if (!current) throw new SavedQueryServiceError('The selected saved query no longer exists.');
    const normalized = normalizeInput(input);
    return this.repository.update({
      ...current,
      ...normalized,
      updatedAt: new Date().toISOString(),
    });
  }

  deleteQuery(id: string): void {
    if (!this.repository.delete(id)) {
      throw new SavedQueryServiceError('The selected saved query no longer exists.');
    }
  }
}

function normalizeInput(input: CreateSavedQueryInput): Pick<SavedQuery, 'name' | 'description' | 'sqlText'> {
  const name = input.name.trim();
  const sqlText = input.sqlText.trim();
  const description = input.description?.trim() || null;
  if (!name) throw new SavedQueryServiceError('Saved query name is required.');
  if (!sqlText) throw new SavedQueryServiceError('SQL cannot be empty.');
  return { name, description, sqlText };
}
