"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const connectionProfileRepository_1 = require("../electron/storage/connectionProfileRepository");
const connectionProfileService_1 = require("../electron/storage/connectionProfileService");
const credentialStorage_1 = require("../electron/storage/credentialStorage");
const database_1 = require("../electron/storage/database");
void electron_1.app.whenReady().then(() => {
    const testDirectory = (0, node_fs_1.mkdtempSync)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'supra-safe-storage-'));
    const database = (0, database_1.initializeDatabase)(node_path_1.default.join(testDirectory, 'safe-storage.db'));
    try {
        strict_1.default.equal(electron_1.safeStorage.isEncryptionAvailable(), true, 'Electron safeStorage must be available on Windows');
        const repository = new connectionProfileRepository_1.ConnectionProfileRepository(database);
        const service = new connectionProfileService_1.ConnectionProfileService(repository, new credentialStorage_1.ElectronCredentialStorage());
        const plaintextPassword = 'integration-secret-that-must-not-leak';
        const profile = service.createProfile({
            name: 'Safe storage integration',
            host: 'integration-host',
            port: 5432,
            database: 'integration_database',
            username: 'integration_user',
            environment: 'TEST',
            password: plaintextPassword,
            savePasswordSecurely: true,
        });
        const ciphertext = repository.findById(profile.id)?.encryptedPassword;
        strict_1.default.ok(ciphertext);
        strict_1.default.equal(ciphertext.includes(Buffer.from(plaintextPassword)), false);
        strict_1.default.equal(profile.hasStoredPassword, true);
        strict_1.default.equal('password' in profile, false);
        strict_1.default.equal('encryptedPassword' in profile, false);
        process.stdout.write(`Electron safeStorage integration: passed (Node ${process.versions.node}, ABI ${process.versions.modules})\n`);
    }
    catch {
        process.stderr.write('Electron safeStorage integration: failed\n');
        process.exitCode = 1;
    }
    finally {
        database.close();
        (0, node_fs_1.rmSync)(testDirectory, { recursive: true, force: true });
        electron_1.app.quit();
    }
});
