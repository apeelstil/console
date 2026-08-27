import { app, BrowserWindow, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { registerConnectionProfileHandlers } from './ipc/connectionProfileHandlers';
import { registerPostgresConnectionHandlers } from './ipc/postgresConnectionHandlers';
import { registerPostgresMetadataHandlers } from './ipc/postgresMetadataHandlers';
import { registerQueryExecutionHandlers } from './ipc/queryExecutionHandlers';
import { registerLocalQueryDataHandlers } from './ipc/localQueryDataHandlers';
import { registerMutationTransactionHandlers } from './ipc/mutationTransactionHandlers';
import { PostgresConnectionManager } from './postgres/postgresConnectionManager';
import { PostgresMetadataService } from './postgres/postgresMetadataService';
import type { PostgresQueryExecutionService } from './postgres/postgresQueryExecutionService';
import type { MutationTransactionManager } from './postgres/mutationTransactionManager';
import { PostgresOperationGate } from './postgres/postgresOperationGate';
import { ConnectionProfileRepository } from './storage/connectionProfileRepository';
import { ConnectionProfileService } from './storage/connectionProfileService';
import { initializeDatabase, LOCAL_DATABASE_FILENAME } from './storage/database';
import { SavedQueryRepository } from './storage/savedQueryRepository';
import { SavedQueryService } from './storage/savedQueryService';
import { AuditLogRepository, QueryHistoryRepository } from './storage/queryActivityRepository';
import { LocalQueryActivityService, NodeAuditIdentityProvider } from './storage/queryActivityService';
import { POSTGRES_CONNECTION_CHANNELS } from '../shared/postgresConnection';
import { MUTATION_TRANSACTION_CHANNELS } from '../shared/mutationTransaction';
import { QUERY_EXECUTION_CHANNELS } from '../shared/queryExecution';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const startupStartedAt = performance.now();
let localDatabase: Database.Database | undefined;
let profileService: ConnectionProfileService | undefined;
let connectionManager: PostgresConnectionManager | undefined;
let metadataService: PostgresMetadataService | undefined;
let queryExecutionService: PostgresQueryExecutionService | undefined;
let savedQueryService: SavedQueryService | undefined;
let queryActivityService: LocalQueryActivityService | undefined;
let mutationTransactionManager: MutationTransactionManager | undefined;
const postgresOperationGate = new PostgresOperationGate();
let shutdownStarted = false;

function markStartup(label: string): void {
  if (!isDevelopment) return;
  const elapsedMs = Math.round(performance.now() - startupStartedAt);
  console.info(`[SUPRA startup +${elapsedMs}ms] ${label}`);
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send(channel, payload);
    } catch {
      // A closing renderer must not interrupt main-process cleanup.
    }
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#111827',
    icon: path.join(__dirname, '../../assets/supra-icon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    markStartup('window ready to show');
    window.show();
  });
  window.webContents.once('did-finish-load', () => markStartup('renderer loaded'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowedUrl = isDevelopment ? process.env.VITE_DEV_SERVER_URL : undefined;
    if (!allowedUrl || new URL(url).origin !== new URL(allowedUrl).origin) event.preventDefault();
  });

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

async function initializeDeferredSqlServices(): Promise<void> {
  const manager = connectionManager;
  const activity = queryActivityService;
  if (!manager || !activity) return;

  try {
    const [queryModule, runnerModule, safetyModule] = await Promise.all([
      import('./postgres/postgresQueryExecutionService.js'),
      import('./postgres/pgCancelableQueryRunner.js'),
      import('./postgres/sqlSafetyService.js'),
    ]);
    const safetyService = new safetyModule.SqlSafetyService();
    await safetyService.initialize();
    const service = new queryModule.PostgresQueryExecutionService(
      manager,
      safetyService,
      activity,
      postgresOperationGate,
      new runnerModule.PgCancelableQueryRunner(),
    );
    queryExecutionService = service;
    service.subscribe((state) => {
      broadcast(QUERY_EXECUTION_CHANNELS.stateChanged, state);
    });
  } catch {
    queryExecutionService = undefined;
    markStartup('SELECT services unavailable');
  }

  try {
    const [managerModule, safetyModule] = await Promise.all([
      import('./postgres/mutationTransactionManager.js'),
      import('./postgres/mutationSafetyService.js'),
    ]);
    const safetyService = new safetyModule.MutationSafetyService();
    await safetyService.initialize();
    const transactionManager = new managerModule.MutationTransactionManager(
      manager,
      safetyService,
      postgresOperationGate,
      activity,
    );
    mutationTransactionManager = transactionManager;
    transactionManager.subscribe((state) => {
      broadcast(MUTATION_TRANSACTION_CHANNELS.stateChanged, state);
    });
  } catch {
    mutationTransactionManager = undefined;
    markStartup('mutation services unavailable');
  }

  markStartup('deferred SQL services ready');
}

ipcMain.handle('app:get-platform', () => process.platform);
registerConnectionProfileHandlers(() => profileService);
registerPostgresConnectionHandlers(() => connectionManager);
registerPostgresMetadataHandlers(() => metadataService);
registerQueryExecutionHandlers(() => queryExecutionService);
registerLocalQueryDataHandlers(() => savedQueryService, () => queryActivityService);
registerMutationTransactionHandlers(() => mutationTransactionManager);

void app.whenReady().then(() => {
  markStartup('Electron ready');
  try {
    const databasePath = path.join(app.getPath('userData'), LOCAL_DATABASE_FILENAME);
    localDatabase = initializeDatabase(databasePath);
    const profileRepository = new ConnectionProfileRepository(localDatabase);
    profileService = new ConnectionProfileService(profileRepository);
    savedQueryService = new SavedQueryService(new SavedQueryRepository(localDatabase));
    queryActivityService = new LocalQueryActivityService(
      new QueryHistoryRepository(localDatabase),
      new AuditLogRepository(localDatabase),
      new NodeAuditIdentityProvider(),
    );
    connectionManager = new PostgresConnectionManager(
      (config) => new Client(config),
      profileRepository,
      postgresOperationGate,
    );
    metadataService = new PostgresMetadataService(connectionManager);
    connectionManager.subscribe((state) => {
      if (state.status === 'ERROR' || state.status === 'DISCONNECTED') {
        void mutationTransactionManager?.handleConnectionLoss();
      }
      broadcast(POSTGRES_CONNECTION_CHANNELS.stateChanged, state);
    });
    markStartup('local storage and connection services ready');
  } catch {
    profileService = undefined;
  }

  connectionManager?.setBeforeDisconnectHandler(async () => {
    await queryExecutionService?.cancelBeforeDisconnect();
    await mutationTransactionManager?.rollbackBeforeDisconnect();
  });

  createWindow();
  markStartup('BrowserWindow created');
  void initializeDeferredSqlServices();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void (async () => {
    await connectionManager?.shutdown();
    if (localDatabase?.open) localDatabase.close();
    app.quit();
  })();
});
