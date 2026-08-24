import { useState } from 'react';
import type { DatabaseColumn } from '../../shared/databaseMetadata';
import {
  addWhereCondition,
  clearSelectedColumns,
  prepareGeneratedSql,
  removeWhereCondition,
  resetQueryBuilder,
  selectAllColumns,
  toggleSelectedColumn,
  updateWhereCondition,
  type QueryBuilderState,
} from '../queryBuilder/queryBuilderModel';
import {
  getAllowedOperators,
  getColumnValueKind,
  operatorNeedsValue,
  QueryBuilderValidationError,
  type SqlOperator,
} from '../queryBuilder/sqlSelectGenerator';
import { SqlReplaceConfirmation } from './SqlReplaceConfirmation';

interface QueryBuilderProps {
  state: QueryBuilderState;
  editorSql: string;
  onChange: (state: QueryBuilderState) => void;
  onGeneratedSql: (sql: string) => void;
}

export function QueryBuilder({ state, editorSql, onChange, onGeneratedSql }: QueryBuilderProps) {
  const [validationError, setValidationError] = useState<string>();
  const [pendingSql, setPendingSql] = useState<string>();

  const updateState = (nextState: QueryBuilderState) => {
    setValidationError(undefined);
    onChange(nextState);
  };

  const generateSql = () => {
    try {
      const request = prepareGeneratedSql(state, editorSql);
      setValidationError(undefined);
      if (request.requiresConfirmation) setPendingSql(request.sql);
      else onGeneratedSql(request.sql);
    } catch (error: unknown) {
      setValidationError(
        error instanceof QueryBuilderValidationError
          ? error.safeMessage
          : error instanceof Error
            ? error.message
            : 'Не удалось сформировать SQL.',
      );
    }
  };

  const replaceSql = () => {
    if (!pendingSql) return;
    onGeneratedSql(pendingSql);
    setPendingSql(undefined);
  };

  return (
    <section className="builder panel">
      <div className="panel-heading builder-heading">
        <div><span>Конструктор запросов</span><small>Визуальная подготовка SELECT</small></div>
        <button
          type="button"
          className="secondary compact-action"
          disabled={!state.object}
          onClick={() => updateState(resetQueryBuilder(state))}
        >Сбросить</button>
      </div>

      {!state.object ? (
        <div className="builder-empty">Выберите таблицу или представление слева.</div>
      ) : (
        <div className="builder-content">
          <div className="builder-source">
            <label>Схема<input readOnly value={state.object.schema} /></label>
            <label>{state.object.type === 'VIEW' ? 'Представление' : 'Таблица'}<input readOnly value={state.object.name} /></label>
            <span className={`object-type ${state.object.type.toLowerCase()}`}>{state.object.type}</span>
          </div>

          <div className="builder-workspace">
            <section className="field-picker">
              <div className="builder-section-heading">
                <span>Поля SELECT <small>{state.selectedColumns.length}/{state.columns.length}</small></span>
                <div>
                  <button type="button" disabled={state.columns.length === 0} onClick={() => updateState(selectAllColumns(state))}>Выбрать все</button>
                  <button type="button" disabled={state.selectedColumns.length === 0} onClick={() => updateState(clearSelectedColumns(state))}>Очистить</button>
                </div>
              </div>
              <div className="field-list">
                {state.columns.length === 0 ? (
                  <div className="builder-inline-empty">Метаданные столбцов загружаются или недоступны.</div>
                ) : state.columns.map((column) => (
                  <label className="field-option" key={column.name}>
                    <input
                      type="checkbox"
                      checked={state.selectedColumns.includes(column.name)}
                      onChange={() => updateState(toggleSelectedColumn(state, column.name))}
                    />
                    <span className="field-option-name">{column.name}</span>
                    <span className="field-option-type">{column.nativeType ?? column.dataType}</span>
                    {!column.nullable && <span className="field-required">NN</span>}
                  </label>
                ))}
              </div>
            </section>

            <div className="builder-clauses">
              <section className="where-builder">
                <div className="builder-section-heading">
                  <span>WHERE</span>
                  <div className="match-mode">
                    <label>
                      Условия
                      <select
                        value={state.matchMode}
                        onChange={(event) => updateState({
                          ...state,
                          matchMode: event.target.value === 'OR' ? 'OR' : 'AND',
                        })}
                      >
                        <option value="AND">Все условия (AND)</option>
                        <option value="OR">Любое условие (OR)</option>
                      </select>
                    </label>
                    <button type="button" disabled={state.columns.length === 0} onClick={() => updateState(addWhereCondition(state))}>+ Добавить условие</button>
                  </div>
                </div>
                <div className="conditions-list">
                  {state.conditions.length === 0 ? (
                    <div className="builder-inline-empty">Нет условий</div>
                  ) : state.conditions.map((condition, index) => {
                    const column = state.columns.find((candidate) => candidate.name === condition.column);
                    if (!column) return null;
                    return (
                      <ConditionRow
                        key={condition.id}
                        index={index}
                        column={column}
                        columns={state.columns}
                        operator={condition.operator}
                        value={condition.value}
                        onColumnChange={(columnName) => updateState(updateWhereCondition(
                          state,
                          condition.id,
                          { column: columnName },
                        ))}
                        onOperatorChange={(operator) => updateState(updateWhereCondition(
                          state,
                          condition.id,
                          { operator },
                        ))}
                        onValueChange={(value) => updateState(updateWhereCondition(
                          state,
                          condition.id,
                          { value },
                        ))}
                        onRemove={() => updateState(removeWhereCondition(state, condition.id))}
                      />
                    );
                  })}
                </div>
              </section>

              <section className="builder-options">
                <label>ORDER BY
                  <select
                    value={state.orderByColumn}
                    onChange={(event) => updateState({ ...state, orderByColumn: event.target.value })}
                  >
                    <option value="">Нет</option>
                    {state.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                  </select>
                </label>
                <label>Направление
                  <select
                    disabled={!state.orderByColumn}
                    value={state.orderDirection}
                    onChange={(event) => updateState({
                      ...state,
                      orderDirection: event.target.value === 'DESC' ? 'DESC' : 'ASC',
                    })}
                  >
                    <option value="ASC">ASC</option>
                    <option value="DESC">DESC</option>
                  </select>
                </label>
                <label>LIMIT
                  <input
                    inputMode="numeric"
                    value={state.limit}
                    onChange={(event) => updateState({ ...state, limit: event.target.value })}
                    aria-describedby="limit-help"
                  />
                  <small id="limit-help">1–10000</small>
                </label>
                <button
                  type="button"
                  className="generate-button"
                  disabled={state.columns.length === 0}
                  onClick={generateSql}
                >Сформировать SQL</button>
              </section>
              {validationError && <div className="builder-validation" role="alert">{validationError}</div>}
            </div>
          </div>
        </div>
      )}

      {pendingSql && (
        <SqlReplaceConfirmation
          sourceLabel="сформированным запросом"
          onCancel={() => setPendingSql(undefined)}
          onReplace={replaceSql}
        />
      )}
    </section>
  );
}

interface ConditionRowProps {
  index: number;
  column: DatabaseColumn;
  columns: DatabaseColumn[];
  operator: SqlOperator;
  value: string;
  onColumnChange: (column: string) => void;
  onOperatorChange: (operator: SqlOperator) => void;
  onValueChange: (value: string) => void;
  onRemove: () => void;
}

function ConditionRow({
  index,
  column,
  columns,
  operator,
  value,
  onColumnChange,
  onOperatorChange,
  onValueChange,
  onRemove,
}: ConditionRowProps) {
  const valueKind = getColumnValueKind(column);
  const needsValue = operatorNeedsValue(operator);
  return (
    <div className="condition-row">
      <span className="condition-number">{index + 1}</span>
      <select aria-label={`Столбец условия ${index + 1}`} value={column.name} onChange={(event) => onColumnChange(event.target.value)}>
        {columns.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
      </select>
      <select aria-label={`Оператор условия ${index + 1}`} value={operator} onChange={(event) => onOperatorChange(event.target.value as SqlOperator)}>
        {getAllowedOperators(column).map((allowedOperator) => <option key={allowedOperator} value={allowedOperator}>{allowedOperator}</option>)}
      </select>
      {needsValue && valueKind === 'boolean' ? (
        <select aria-label={`Значение условия ${index + 1}`} value={value} onChange={(event) => onValueChange(event.target.value)}>
          <option value="TRUE">TRUE</option>
          <option value="FALSE">FALSE</option>
        </select>
      ) : needsValue ? (
        <input
          aria-label={`Значение условия ${index + 1}`}
          inputMode={valueKind === 'numeric' ? 'decimal' : undefined}
          placeholder="Значение"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        />
      ) : <span className="condition-no-value">Без значения</span>}
      <button type="button" className="remove-condition" aria-label={`Удалить условие ${index + 1}`} title="Удалить" onClick={onRemove}>×</button>
    </div>
  );
}
