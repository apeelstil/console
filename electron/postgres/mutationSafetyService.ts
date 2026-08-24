import { deparse, loadModule, parse } from 'pgsql-parser';
import type { MutationOperation, MutationTarget } from '../../shared/mutationTransaction';
import { USER_MESSAGES } from '../../shared/userMessages';

const MAX_SQL_LENGTH = 1_000_000;

export interface SafeMutationQuery {
  operation: MutationOperation;
  target: MutationTarget;
  normalizedSql: string;
}

export interface MutationSafetyErrorDetails {
  message: string;
  operation: MutationOperation | 'MUTATION';
  target?: MutationTarget;
}

export class MutationSafetyError extends Error {
  constructor(public readonly details: MutationSafetyErrorDetails) {
    super(details.message);
    this.name = 'MutationSafetyError';
  }
}

export class MutationSafetyService {
  async initialize(): Promise<void> {
    await loadModule();
  }

  async validateMutation(sql: string): Promise<SafeMutationQuery> {
    if (!sql.trim()) throw blocked('Введите один запрос INSERT или UPDATE.');
    if (sql.length > MAX_SQL_LENGTH) throw blocked('SQL-запрос слишком большой.');

    let parsed: Awaited<ReturnType<typeof parse>>;
    try {
      parsed = await parse(sql);
    } catch {
      throw blocked('Не удалось безопасно разобрать синтаксис запроса изменения.');
    }

    const statements = parsed.stmts ?? [];
    if (statements.length !== 1) {
      throw blocked('Разрешён ровно один запрос INSERT или UPDATE.');
    }

    const root = statements[0]?.stmt as unknown;
    if (!isRecord(root)) throw blocked('Разрешены только INSERT или UPDATE.');

    let operation: MutationOperation;
    let statement: Record<string, unknown>;
    if (isRecord(root.InsertStmt)) {
      operation = 'INSERT';
      statement = root.InsertStmt;
    } else if (isRecord(root.UpdateStmt)) {
      operation = 'UPDATE';
      statement = root.UpdateStmt;
    } else {
      throw blocked('Разрешены только INSERT или UPDATE.');
    }

    const target = readTarget(statement, operation);
    if (containsModifyingCte(statement)) {
      throw blocked('CTE, изменяющие данные, запрещены.', operation, target);
    }
    if (hasReturningClause(statement)) {
      throw blocked('RETURNING для изменений на этом этапе запрещён.', operation, target);
    }

    if (operation === 'UPDATE' && !isRecord(statement.whereClause)) {
      throw blocked(USER_MESSAGES.updateRequiresWhere, operation, target);
    }
    if (operation === 'INSERT') {
      const conflict = statement.onConflictClause;
      if (isRecord(conflict) && conflict.action === 'ONCONFLICT_UPDATE') {
        throw blocked('ON CONFLICT DO UPDATE запрещён.', operation, target);
      }
    }

    let normalizedSql: string;
    try {
      normalizedSql = removeTrailingSemicolon((await deparse(parsed)).trim());
    } catch {
      throw blocked('Не удалось безопасно подготовить запрос изменения.', operation, target);
    }
    if (!normalizedSql) throw blocked('Введите один запрос INSERT или UPDATE.', operation, target);

    return { operation, target, normalizedSql };
  }
}

function readTarget(statement: Record<string, unknown>, operation: MutationOperation): MutationTarget {
  const relation = statement.relation;
  if (!isRecord(relation) || typeof relation.relname !== 'string' || !relation.relname) {
    throw blocked('Не удалось определить объект изменения.', operation);
  }
  if (typeof relation.schemaname !== 'string' || !relation.schemaname) {
    throw blocked('Для INSERT и UPDATE требуется явно указать схему объекта.', operation);
  }

  const schema = relation.schemaname;
  const normalizedSchema = schema.toLowerCase();
  const target = { schema, table: relation.relname };
  if (normalizedSchema === 'pg_catalog'
    || normalizedSchema === 'information_schema'
    || normalizedSchema.startsWith('pg_')) {
    throw blocked('Изменения системных схем PostgreSQL запрещены.', operation, target);
  }
  return target;
}

function hasReturningClause(statement: Record<string, unknown>): boolean {
  const returning = statement.returningClause;
  if (!isRecord(returning)) return false;
  return Array.isArray(returning.exprs) ? returning.exprs.length > 0 : true;
}

function containsModifyingCte(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsModifyingCte);
  if (!isRecord(value)) return false;

  const commonTableExpression = value.CommonTableExpr;
  if (isRecord(commonTableExpression) && isRecord(commonTableExpression.ctequery)) {
    const query = commonTableExpression.ctequery;
    if (isRecord(query.InsertStmt)
      || isRecord(query.UpdateStmt)
      || isRecord(query.DeleteStmt)
      || isRecord(query.MergeStmt)) return true;
  }
  return Object.values(value).some(containsModifyingCte);
}

function blocked(
  message: string,
  operation: MutationOperation | 'MUTATION' = 'MUTATION',
  target?: MutationTarget,
): MutationSafetyError {
  return new MutationSafetyError({ message, operation, ...(target ? { target } : {}) });
}

function removeTrailingSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
