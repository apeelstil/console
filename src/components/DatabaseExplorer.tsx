import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type {
  DatabaseColumn,
  DatabaseMetadataSearchResult,
  DatabaseObject,
  DatabaseObjectType,
  PostgresMetadataApi,
} from '../../shared/databaseMetadata';
import type { ActiveConnectionInfo } from '../../shared/postgresConnection';
import {
  DatabaseExplorerController,
  groupCacheKey,
  objectCacheKey,
  schemaCacheKey,
  type DatabaseExplorerSelection,
  type MetadataLoadState,
} from '../databaseExplorerController';

interface DatabaseExplorerProps {
  connection?: ActiveConnectionInfo;
  onSelectionChange: (selection?: DatabaseExplorerSelection) => void;
}

const unavailableMetadataApi: PostgresMetadataApi = {
  listSchemas: async () => ({ ok: false, error: 'Просмотр метаданных базы данных недоступен.' }),
  listSchemaObjects: async () => ({ ok: false, error: 'Просмотр метаданных базы данных недоступен.' }),
  listColumns: async () => ({ ok: false, error: 'Просмотр метаданных базы данных недоступен.' }),
  searchDatabaseMetadata: async () => ({ ok: false, error: 'Поиск по метаданным базы данных недоступен.' }),
};

export function DatabaseExplorer({ connection, onSelectionChange }: DatabaseExplorerProps) {
  const controller = useMemo(
    () => new DatabaseExplorerController(window.supraDesktop ?? unavailableMetadataApi),
    [],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const activeSession = connection ? connectionSessionKey(connection) : undefined;
  const lastSession = useRef<string | undefined>(undefined);
  const selection = useMemo(() => controller.getSelection(state), [controller, state]);
  const searchActive = Boolean(state.search.query.trim());

  useEffect(() => {
    if (activeSession && lastSession.current !== activeSession) {
      lastSession.current = activeSession;
      void controller.activate(activeSession);
    } else if (!activeSession && lastSession.current) {
      lastSession.current = undefined;
      controller.disconnect();
    }
  }, [activeSession, controller]);

  useEffect(() => {
    onSelectionChange(selection);
  }, [onSelectionChange, selection]);

  return (
    <div className="database-explorer">
      <div className="sidebar-title">
        Объекты базы данных
        <button
          aria-label="Обновить объекты базы данных"
          title="Обновить"
          disabled={!connection || state.schemas.status === 'loading'}
          onClick={() => void controller.refresh()}
        >↻ Обновить</button>
      </div>
      <div className="explorer-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          aria-label="Поиск по объектам базы данных"
          placeholder="Поиск"
          value={state.search.query}
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          disabled={!connection}
          onChange={(event) => void controller.searchMetadata(event.target.value)}
        />
        {searchActive && (
          <button type="button" aria-label="Очистить поиск" title="Очистить" onClick={() => controller.clearSearch()}>×</button>
        )}
      </div>
      <div className="explorer-tree" role="tree" aria-label="Объекты базы данных">
        {!connection && <div className="empty-connection">Нет активного подключения</div>}
        {connection && searchActive && <SearchResults state={state.search} onSelect={(result) => void controller.revealSearchResult(result)} />}
        {connection && !searchActive && <>
          <TreeRow depth={0} expanded icon="database" label={connection.name} detail={connection.environment} />
          <TreeRow depth={1} expanded icon="folder" label="Схемы" />
          {state.schemas.status === 'loading' && <TreeMessage depth={2} message="Загрузка…" />}
          {state.schemas.status === 'error' && <TreeError depth={2} message={state.schemas.error ?? 'Не удалось загрузить схемы.'} onRetry={() => void controller.retrySchemas()} />}
          {state.schemas.status === 'loaded' && state.schemas.data.length === 0 && <TreeMessage depth={2} message="Нет пользовательских схем" />}
          {state.schemas.data.map((schema) => {
            const key = schemaCacheKey(schema.name);
            const expanded = state.expandedSchemas.includes(key);
            const objects = state.objectsBySchema[key];
            return <div key={key}>
              <TreeRow depth={2} expanded={expanded} icon="schema" label={schema.name} onClick={() => void controller.toggleSchema(schema.name)} />
              {expanded && <>
                {objects?.status === 'loading' && <TreeMessage depth={3} message="Загрузка…" />}
                {objects?.status === 'error' && <TreeError depth={3} message={objects.error ?? 'Не удалось загрузить таблицы и представления.'} onRetry={() => void controller.retrySchema(schema.name)} />}
                {objects?.status === 'loaded' && <ObjectGroup type="TABLE" schema={schema.name} objects={objects.data} state={state} controller={controller} />}
                {objects?.status === 'loaded' && <ObjectGroup type="VIEW" schema={schema.name} objects={objects.data} state={state} controller={controller} />}
              </>}
            </div>;
          })}
        </>}
      </div>
    </div>
  );
}

function SearchResults({ state, onSelect }: {
  state: ReturnType<DatabaseExplorerController['getSnapshot']>['search'];
  onSelect: (result: DatabaseMetadataSearchResult) => void;
}) {
  if (state.query.trim().length < 2) {
    return <div className="explorer-search-state">Введите минимум 2 символа</div>;
  }
  if (state.status === 'loading') {
    return <div className="explorer-search-state" role="status">Поиск…</div>;
  }
  if (state.status === 'error') {
    return <div className="explorer-search-state error" role="alert">{state.error ?? 'Не удалось выполнить поиск.'}</div>;
  }
  if (state.status === 'loaded' && state.data.length === 0) {
    return <div className="explorer-search-state">Ничего не найдено</div>;
  }

  return <div className="explorer-search-results">{state.data.map((result, index) => (
    <button
      type="button"
      role="treeitem"
      className="explorer-search-result"
      key={searchResultKey(result, index)}
      title={searchResultLabel(result)}
      onClick={() => onSelect(result)}
    >
      <span className={`tree-icon ${searchResultIcon(result)}`}>{iconGlyph(searchResultIcon(result))}</span>
      <span className="search-result-label">{searchResultLabel(result)}</span>
      <small>{searchResultDetail(result)}</small>
    </button>
  ))}</div>;
}

interface ObjectGroupProps {
  type: DatabaseObjectType;
  schema: string;
  objects: DatabaseObject[];
  state: ReturnType<DatabaseExplorerController['getSnapshot']>;
  controller: DatabaseExplorerController;
}

function ObjectGroup({ type, schema, objects, state, controller }: ObjectGroupProps) {
  const key = groupCacheKey(schema, type);
  const expanded = state.expandedGroups.includes(key);
  const matchingObjects = objects.filter((object) => object.type === type);
  const label = type === 'TABLE' ? 'Таблицы' : 'Представления';

  return <div>
    <TreeRow depth={3} expanded={expanded} icon="folder" label={label} detail={String(matchingObjects.length)} onClick={() => controller.toggleGroup(schema, type)} />
    {expanded && matchingObjects.length === 0 && <TreeMessage depth={4} message={`Нет: ${label.toLowerCase()}`} />}
    {expanded && matchingObjects.map((object) => {
      const objectKey = objectCacheKey(object.schema, object.name);
      const columns = state.columnsByObject[objectKey];
      const objectExpanded = state.expandedObjects.includes(objectKey);
      const selected = state.selectedObject?.schema === object.schema
        && state.selectedObject?.name === object.name
        && state.selectedObject?.type === object.type;

      return <div key={objectKey}>
        <TreeRow depth={4} expanded={objectExpanded} selected={selected} icon={type === 'TABLE' ? 'table' : 'view'} label={object.name} onClick={() => void controller.selectObject(object)} />
        {objectExpanded && <ColumnRows object={object} columns={columns} onRetry={() => void controller.retryColumns(object)} />}
      </div>;
    })}
  </div>;
}

interface ColumnRowsProps {
  object: DatabaseObject;
  columns?: MetadataLoadState<DatabaseColumn[]>;
  onRetry: () => void;
}

function ColumnRows({ object, columns, onRetry }: ColumnRowsProps) {
  if (!columns || columns.status === 'loading') return <TreeMessage depth={5} message="Загрузка…" />;
  if (columns.status === 'error') return <TreeError depth={5} message={columns.error ?? 'Не удалось загрузить столбцы.'} onRetry={onRetry} />;
  if (columns.data.length === 0) return <TreeMessage depth={5} message="Нет столбцов" />;

  return <>{columns.data.map((column) => (
    <div className="column-row" style={{ paddingLeft: 70 }} key={`${object.schema}.${object.name}.${column.name}`}>
      <span className="column-icon">◇</span>
      <span className="column-name">{column.name}</span>
      <span className="column-type">{column.nativeType ?? column.dataType}</span>
      {!column.nullable && <span className="not-null">NN</span>}
    </div>
  ))}</>;
}

interface TreeRowProps {
  depth: number;
  expanded?: boolean;
  selected?: boolean;
  icon: 'database' | 'folder' | 'schema' | 'table' | 'view';
  label: string;
  detail?: string;
  onClick?: () => void;
}

function TreeRow({ depth, expanded, selected, icon, label, detail, onClick }: TreeRowProps) {
  return <button
    type="button"
    role="treeitem"
    aria-expanded={onClick ? expanded : undefined}
    aria-selected={selected}
    className={`explorer-row ${selected ? 'selected' : ''}`}
    style={{ paddingLeft: 7 + depth * 14 }}
    onClick={onClick}
  >
    <span className="tree-toggle">{onClick ? expanded ? '⌄' : '›' : '⌄'}</span>
    <span className={`tree-icon ${icon}`}>{iconGlyph(icon)}</span>
    <span className="tree-label">{label}</span>
    {detail && <span className="tree-detail">{detail}</span>}
  </button>;
}

function TreeMessage({ depth, message }: { depth: number; message: string }) {
  return <div className="tree-message" style={{ paddingLeft: 23 + depth * 14 }}>{message}</div>;
}

function TreeError({ depth, message, onRetry }: { depth: number; message: string; onRetry: () => void }) {
  return <div className="tree-error" role="status" style={{ paddingLeft: 23 + depth * 14 }}><span title={message}>{message}</span><button type="button" onClick={onRetry}>Повторить</button></div>;
}

function iconGlyph(icon: TreeRowProps['icon']): string {
  if (icon === 'database') return '◆';
  if (icon === 'table') return '▦';
  if (icon === 'view') return '▤';
  if (icon === 'schema') return '▱';
  return '▰';
}

function searchResultLabel(result: DatabaseMetadataSearchResult): string {
  if (result.type === 'SCHEMA') return result.schema;
  const objectLabel = `${result.schema}.${result.objectName ?? ''}`;
  return result.type === 'COLUMN' ? `${objectLabel} → ${result.columnName ?? ''}` : objectLabel;
}

function searchResultDetail(result: DatabaseMetadataSearchResult): string {
  if (result.type === 'SCHEMA') return 'Схема';
  if (result.type === 'TABLE') return 'Таблица';
  if (result.type === 'VIEW') return 'Представление';
  return result.nativeType ?? result.dataType ?? 'Столбец';
}

function searchResultIcon(result: DatabaseMetadataSearchResult): TreeRowProps['icon'] {
  if (result.type === 'SCHEMA') return 'schema';
  if (result.type === 'VIEW' || result.objectType === 'VIEW') return 'view';
  return 'table';
}

function searchResultKey(result: DatabaseMetadataSearchResult, index: number): string {
  return JSON.stringify([result.type, result.schema, result.objectName, result.columnName, index]);
}

function connectionSessionKey(connection: ActiveConnectionInfo): string {
  return JSON.stringify([
    connection.profileId ?? '',
    connection.name,
    connection.host,
    connection.port,
    connection.database,
    connection.username,
    connection.environment,
  ]);
}
