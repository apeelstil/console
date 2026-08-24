import { app, BrowserWindow, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { Client } from 'pg';
import { registerConnectionProfileHandlers } from './ipc/connectionProfileHandlers';
import { registerPostgresConnectionHandlers } from './ipc/postgresConnectionHandlers';
import { registerPostgresMetadataHandlers } from './ipc/postgresMetadataHandlers';
import { registerQueryExecutionHandlers } from './ipc/queryExecutionHandlers';
import { registerLocalQueryDataHandlers } from './ipc/localQueryDataHandlers';
import { registerMutationTransactionHandlers } from './ipc/mutationTransactionHandlers';
import { PostgresConnectionManager } from './postgres/postgresConnectionManager';
import { PostgresMetadataService } from './postgres/postgresMetadataService';
import { PostgresQueryExecutionService } from './postgres/postgresQueryExecutionService';
import { SqlSafetyService } from './postgres/sqlSafetyService';
import { MutationSafetyService } from './postgres/mutationSafetyService';
import { MutationTransactionManager } from './postgres/mutationTransactionManager';
import { PostgresOperationGate } from './postgres/postgresOperationGate';
import { ConnectionProfileRepository } from './storage/connectionProfileRepository';
import { ConnectionProfileService } from './storage/connectionProfileService';
import { ElectronCredentialStorage } from './storage/credentialStorage';
import { initializeDatabase, LOCAL_DATABASE_FILENAME } from './storage/database';
import { SavedQueryRepository } from './storage/savedQueryRepository';
import { SavedQueryService } from './storage/savedQueryService';
import { AuditLogRepository, QueryHistoryRepository } from './storage/queryActivityRepository';
import { LocalQueryActivityService, NodeAuditIdentityProvider } from './storage/queryActivityService';
import { POSTGRES_CONNECTION_CHANNELS } from '../shared/postgresConnection';
import { MUTATION_TRANSACTION_CHANNELS } from '../shared/mutationTransaction';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
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

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#111827',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
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

ipcMain.handle('app:get-platform', () => process.platform);
registerConnectionProfileHandlers(() => profileService);
registerPostgresConnectionHandlers(() => connectionManager);
registerPostgresMetadataHandlers(() => metadataService);
registerQueryExecutionHandlers(() => queryExecutionService);
registerLocalQueryDataHandlers(() => savedQueryService, () => queryActivityService);
registerMutationTransactionHandlers(() => mutationTransactionManager);

void app.whenReady().then(async () => {
  try {
    const databasePath = path.join(app.getPath('userData'), LOCAL_DATABASE_FILENAME);
    localDatabase = initializeDatabase(databasePath);
    const profileRepository = new ConnectionProfileRepository(localDatabase);
    const credentialStorage = new ElectronCredentialStorage();
    profileService = new ConnectionProfileService(
      profileRepository,
      credentialStorage,
    );
    savedQueryService = new SavedQueryService(new SavedQueryRepository(localDatabase));
    queryActivityService = new LocalQueryActivityService(
      new QueryHistoryRepository(localDatabase),
      new AuditLogRepository(localDatabase),
      new NodeAuditIdentityProvider(),
    );
    connectionManager = new PostgresConnectionManager(
      (config) => new Client(config),
      profileRepository,
      credentialStorage,
      postgresOperationGate,
    );
    metadataService = new PostgresMetadataService(connectionManager);
    connectionManager.subscribe((state) => {
      if (state.status === 'ERROR' || state.status === 'DISCONNECTED') {
        void mutationTransactionManager?.handleConnectionLoss();
      }
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(POSTGRES_CONNECTION_CHANNELS.stateChanged, state);
      }
    });
  } catch {
    profileService = undefined;
  }

  if (connectionManager) {
    try {
      const safetyService = new SqlSafetyService();
      await safetyService.initialize();
      if (!queryActivityService) throw new Error('Local query activity storage is unavailable.');
      queryExecutionService = new PostgresQueryExecutionService(
        connectionManager,
        safetyService,
        queryActivityService,
      );
    } catch {
      queryExecutionService = undefined;
    }
  }

  if (connectionManager && queryActivityService) {
    try {
      const mutationSafetyService = new MutationSafetyService();
      await mutationSafetyService.initialize();
      mutationTransactionManager = new MutationTransactionManager(
        connectionManager,
        mutationSafetyService,
        postgresOperationGate,
        queryActivityService,
      );
      connectionManager.setBeforeDisconnectHandler(() =>
        mutationTransactionManager?.rollbackBeforeDisconnect() ?? Promise.resolve());
      mutationTransactionManager.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(MUTATION_TRANSACTION_CHANNELS.stateChanged, state);
        }
      });
    } catch {
      mutationTransactionManager = undefined;
    }
  }

  createWindow();
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
