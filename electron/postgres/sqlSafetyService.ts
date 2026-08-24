import { deparse, loadModule, parse } from 'pgsql-parser';
import type { QueryExecutionErrorDto } from '../../shared/queryExecution';

const MAX_SQL_LENGTH = 1_000_000;
const SERVER_ROW_FETCH_LIMIT = 1_001;
const RESULT_ALIAS = '__supra_query_result';

export interface SafeSelectQuery {
  normalizedSql: string;
  executableSql: string;
}

export class SqlSafetyError extends Error {
  constructor(public readonly details: QueryExecutionErrorDto) {
    super(details.message);
    this.name = 'SqlSafetyError';
  }
}

export class SqlSafetyService {
  async initialize(): Promise<void> {
    await loadModule();
  }

  async validateSelect(sql: string): Promise<SafeSelectQuery> {
    if (!sql.trim()) throw notAllowed('Enter a SELECT query.');
    if (sql.length > MAX_SQL_LENGTH) throw notAllowed('The SQL query is too large.');

    let parsed: Awaited<ReturnType<typeof parse>>;
    try {
      parsed = await parse(sql);
    } catch (error: unknown) {
      throw syntaxError(error);
    }

    const statements = parsed.stmts ?? [];
    if (statements.length !== 1) {
      throw notAllowed('Exactly one SELECT statement is required.');
    }

    const rawStatement = statements[0]?.stmt as unknown;
    if (!isRecord(rawStatement) || !isRecord(rawStatement.SelectStmt)) {
      throw notAllowed('Only a SELECT statement is allowed.');
    }

    validateAst(rawStatement);

    let normalizedSql: string;
    try {
      normalizedSql = removeTrailingSemicolon((await deparse(parsed)).trim());
    } catch {
      throw notAllowed('The SELECT query could not be safely prepared.');
    }

    if (!normalizedSql) throw notAllowed('Enter a SELECT query.');
    return {
      normalizedSql,
      executableSql: [
        'SELECT *',
        'FROM (',
        normalizedSql,
        `) AS "${RESULT_ALIAS}"`,
        `LIMIT ${SERVER_ROW_FETCH_LIMIT};`,
      ].join('\n'),
    };
  }
}

function validateAst(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateAst(item);
    return;
  }
  if (!isRecord(value)) return;

  validateSelectNodeRestrictions(value);

  for (const [nodeType, nodeValue] of Object.entries(value)) {
    if (nodeType === 'CommonTableExpr') validateCommonTableExpression(nodeValue);

    if (nodeType.endsWith('Stmt') && nodeType !== 'SelectStmt') {
      throw notAllowed(`Statement type ${nodeType.slice(0, -4)} is not allowed.`);
    }

    if (nodeType === 'SelectStmt') validateSelectNode(nodeValue);
    validateAst(nodeValue);
  }
}

function validateCommonTableExpression(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.ctequery) || !isRecord(value.ctequery.SelectStmt)) {
    throw notAllowed('Data-modifying CTEs are not allowed.');
  }
}

function validateSelectNode(value: unknown): void {
  if (!isRecord(value)) throw notAllowed('Invalid SELECT syntax tree.');
  validateSelectNodeRestrictions(value);
}

function validateSelectNodeRestrictions(value: Record<string, unknown>): void {
  if (value.intoClause !== undefined && value.intoClause !== null) {
    throw notAllowed('SELECT INTO is not allowed.');
  }
  if (Array.isArray(value.lockingClause) && value.lockingClause.length > 0) {
    throw notAllowed('SELECT locking clauses are not allowed.');
  }
  if (Array.isArray(value.valuesLists) && value.valuesLists.length > 0) {
    throw notAllowed('VALUES statements are not allowed; use SELECT.');
  }
}

function syntaxError(error: unknown): SqlSafetyError {
  const details = isRecord(error) && isRecord(error.sqlDetails) ? error.sqlDetails : {};
  const message = typeof details.message === 'string'
    ? limitMessage(details.message)
    : 'The SQL query has invalid PostgreSQL syntax.';
  const cursorPosition = typeof details.cursorPosition === 'number'
    && Number.isSafeInteger(details.cursorPosition)
    && details.cursorPosition >= 0
    ? details.cursorPosition
    : undefined;
  return new SqlSafetyError({
    kind: 'SYNTAX',
    message,
    sqlState: '42601',
    ...(cursorPosition !== undefined ? { position: cursorPosition } : {}),
  });
}

function notAllowed(message: string): SqlSafetyError {
  return new SqlSafetyError({ kind: 'NOT_ALLOWED', message });
}

function removeTrailingSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}

function limitMessage(message: string): string {
  const singleLine = message.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
  return singleLine.slice(0, 240) || 'The SQL query has invalid PostgreSQL syntax.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
