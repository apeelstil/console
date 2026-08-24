import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DatabaseColumn, DatabaseObject, DatabaseObjectType, PostgresMetadataApi } from '../../shared/databaseMetadata';
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
  listSchemas: async () => ({ ok: false, error: 'Database metadata browsing is unavailable.' }),
  listSchemaObjects: async () => ({ ok: false, error: 'Database metadata browsing is unavailable.' }),
  listColumns: async () => ({ ok: false, error: 'Database metadata browsing is unavailable.' }),
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
        Database Explorer
        <button
          aria-label="Refresh database explorer"
          title="Refresh"
          disabled={!connection || state.schemas.status === 'loading'}
          onClick={() => void controller.refresh()}
        >↻ Refresh</button>
      </div>
      <div className="explorer-tree" role="tree" aria-label="Database Explorer">
        {!connection && <div className="empty-connection">No active connection</div>}
        {connection && <>
          <TreeRow depth={0} expanded icon="database" label={connection.name} detail={connection.environment} />
          <TreeRow depth={1} expanded icon="folder" label="Schemas" />
          {state.schemas.status === 'loading' && <TreeMessage depth={2} message="Loading…" />}
          {state.schemas.status === 'error' && <TreeError depth={2} message={state.schemas.error ?? 'Failed to load schemas.'} onRetry={() => void controller.retrySchemas()} />}
          {state.schemas.status === 'loaded' && state.schemas.data.length === 0 && <TreeMessage depth={2} message="No user schemas" />}
          {state.schemas.data.map((schema) => {
            const key = schemaCacheKey(schema.name);
            const expanded = state.expandedSchemas.includes(key);
            const objects = state.objectsBySchema[key];
            return <div key={key}>
              <TreeRow depth={2} expanded={expanded} icon="schema" label={schema.name} onClick={() => void controller.toggleSchema(schema.name)} />
              {expanded && <>
                {objects?.status === 'loading' && <TreeMessage depth={3} message="Loading…" />}
                {objects?.status === 'error' && <TreeError depth={3} message={objects.error ?? 'Failed to load tables and views.'} onRetry={() => void controller.retrySchema(schema.name)} />}
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
  const label = type === 'TABLE' ? 'Tables' : 'Views';

  return <div>
    <TreeRow depth={3} expanded={expanded} icon="folder" label={label} detail={String(matchingObjects.length)} onClick={() => controller.toggleGroup(schema, type)} />
    {expanded && matchingObjects.length === 0 && <TreeMessage depth={4} message={`No ${label.toLowerCase()}`} />}
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
  if (!columns || columns.status === 'loading') return <TreeMessage depth={5} message="Loading…" />;
  if (columns.status === 'error') return <TreeError depth={5} message={columns.error ?? 'Failed to load columns.'} onRetry={onRetry} />;
  if (columns.data.length === 0) return <TreeMessage depth={5} message="No columns" />;

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
  return <div className="tree-error" role="status" style={{ paddingLeft: 23 + depth * 14 }}><span title={message}>{message}</span><button type="button" onClick={onRetry}>Retry</button></div>;
}

function iconGlyph(icon: TreeRowProps['icon']): string {
  if (icon === 'database') return '◆';
  if (icon === 'table') return '▦';
  if (icon === 'view') return '▤';
  if (icon === 'schema') return '▱';
  return '▰';
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
