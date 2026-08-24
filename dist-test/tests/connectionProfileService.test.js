"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importStar(require("node:test"));
const connectionProfileRepository_1 = require("../electron/storage/connectionProfileRepository");
const connectionProfileService_1 = require("../electron/storage/connectionProfileService");
const database_1 = require("../electron/storage/database");
const connectionProfiles_1 = require("../shared/connectionProfiles");
const testDirectory = (0, node_fs_1.mkdtempSync)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'supra-query-console-'));
let databaseSequence = 0;
(0, node_test_1.after)(() => (0, node_fs_1.rmSync)(testDirectory, { recursive: true, force: true }));
const testFields = {
    name: 'SUPRA TEST',
    host: 'test-host',
    port: 5432,
    database: 'supra_test',
    username: 'support_user',
    environment: 'TEST',
};
class FakeCredentialStorage {
    available;
    sequence = 0;
    constructor(available = true) {
        this.available = available;
    }
    isEncryptionAvailable() {
        return this.available;
    }
    encrypt(password) {
        void password;
        this.sequence += 1;
        return Buffer.from(`test-cipher-${this.sequence}`);
    }
    decrypt(encryptedPassword) {
        void encryptedPassword;
        throw new Error('Decryption is not used by profile management.');
    }
}
function createFileDatabase() {
    databaseSequence += 1;
    const databasePath = node_path_1.default.join(testDirectory, `profiles-${databaseSequence}.db`);
    return { databasePath, database: (0, database_1.initializeDatabase)(databasePath) };
}
(0, node_test_1.default)('Scenario A: profile metadata persists after closing and reopening SQLite', () => {
    const { databasePath, database } = createFileDatabase();
    const service = new connectionProfileService_1.ConnectionProfileService(new connectionProfileRepository_1.ConnectionProfileRepository(database), new FakeCredentialStorage());
    const created = service.createProfile({ ...testFields, password: '', savePasswordSecurely: false });
    database.close();
    const reopenedDatabase = (0, database_1.initializeDatabase)(databasePath);
    const reopenedService = new connectionProfileService_1.ConnectionProfileService(new connectionProfileRepository_1.ConnectionProfileRepository(reopenedDatabase), new FakeCredentialStorage());
    const profiles = reopenedService.listProfiles();
    strict_1.default.equal(profiles.length, 1);
    strict_1.default.equal(profiles[0]?.id, created.id);
    strict_1.default.equal(profiles[0]?.hasStoredPassword, false);
    strict_1.default.equal(reopenedDatabase.pragma('user_version', { simple: true }), database_1.CURRENT_SCHEMA_VERSION);
    reopenedDatabase.close();
});
(0, node_test_1.default)('Scenario B: public profile exposes only hasStoredPassword, never password or ciphertext', () => {
    const { database } = createFileDatabase();
    const repository = new connectionProfileRepository_1.ConnectionProfileRepository(database);
    const service = new connectionProfileService_1.ConnectionProfileService(repository, new FakeCredentialStorage());
    const profile = service.createProfile({ ...testFields, password: 'not-returned', savePasswordSecurely: true });
    strict_1.default.equal(profile.hasStoredPassword, true);
    strict_1.default.equal('password' in profile, false);
    strict_1.default.equal('encryptedPassword' in profile, false);
    strict_1.default.equal('encrypted_password' in profile, false);
    strict_1.default.notEqual(repository.findById(profile.id)?.encryptedPassword, null);
    database.close();
});
(0, node_test_1.default)('Scenario C: metadata update keeps existing encrypted password when password mode is keep', () => {
    const { database } = createFileDatabase();
    const repository = new connectionProfileRepository_1.ConnectionProfileRepository(database);
    const service = new connectionProfileService_1.ConnectionProfileService(repository, new FakeCredentialStorage());
    const created = service.createProfile({ ...testFields, password: 'first-password', savePasswordSecurely: true });
    const originalCiphertext = Buffer.from(repository.findById(created.id)?.encryptedPassword ?? []);
    const updated = service.updateProfile({
        ...testFields,
        id: created.id,
        name: 'SUPRA TEST EDITED',
        passwordUpdate: { mode: 'keep' },
    });
    strict_1.default.equal(updated.name, 'SUPRA TEST EDITED');
    strict_1.default.equal(updated.hasStoredPassword, true);
    strict_1.default.deepEqual(repository.findById(created.id)?.encryptedPassword, originalCiphertext);
    database.close();
});
(0, node_test_1.default)('Scenario D: replacing a password replaces the old ciphertext', () => {
    const { database } = createFileDatabase();
    const repository = new connectionProfileRepository_1.ConnectionProfileRepository(database);
    const service = new connectionProfileService_1.ConnectionProfileService(repository, new FakeCredentialStorage());
    const created = service.createProfile({ ...testFields, password: 'first-password', savePasswordSecurely: true });
    const originalCiphertext = Buffer.from(repository.findById(created.id)?.encryptedPassword ?? []);
    service.updateProfile({
        ...testFields,
        id: created.id,
        passwordUpdate: { mode: 'replace', password: 'second-password' },
    });
    strict_1.default.notDeepEqual(repository.findById(created.id)?.encryptedPassword, originalCiphertext);
    database.close();
});
(0, node_test_1.default)('Scenario E: deleting one profile removes it and leaves other profiles untouched', () => {
    const { database } = createFileDatabase();
    const service = new connectionProfileService_1.ConnectionProfileService(new connectionProfileRepository_1.ConnectionProfileRepository(database), new FakeCredentialStorage());
    const first = service.createProfile({ ...testFields, password: 'stored', savePasswordSecurely: true });
    const second = service.createProfile({ ...testFields, name: 'SUPRA DEV', environment: 'DEV', password: '', savePasswordSecurely: false });
    service.deleteProfile(first.id);
    const profiles = service.listProfiles();
    strict_1.default.deepEqual(profiles.map((profile) => profile.id), [second.id]);
    database.close();
});
(0, node_test_1.default)('Scenario F: PROD environment activates the production UI condition', () => {
    strict_1.default.equal((0, connectionProfiles_1.isProductionEnvironment)('PROD'), true);
    strict_1.default.equal((0, connectionProfiles_1.isProductionEnvironment)('TEST'), false);
    strict_1.default.equal((0, connectionProfiles_1.isProductionEnvironment)('DEV'), false);
    strict_1.default.equal((0, connectionProfiles_1.isProductionEnvironment)('OTHER'), false);
});
(0, node_test_1.default)('secure password saving fails closed when encryption is unavailable', () => {
    const { database } = createFileDatabase();
    const service = new connectionProfileService_1.ConnectionProfileService(new connectionProfileRepository_1.ConnectionProfileRepository(database), new FakeCredentialStorage(false));
    strict_1.default.throws(() => service.createProfile({ ...testFields, password: 'must-not-be-stored', savePasswordSecurely: true }), (error) => error instanceof connectionProfileService_1.ProfileServiceError && error.safeMessage.includes('unavailable'));
    strict_1.default.equal(service.listProfiles().length, 0);
    database.close();
});
(0, node_test_1.default)('SQLite constraints and service validation reject invalid metadata', () => {
    const { database } = createFileDatabase();
    const service = new connectionProfileService_1.ConnectionProfileService(new connectionProfileRepository_1.ConnectionProfileRepository(database), new FakeCredentialStorage());
    for (const invalidFields of [
        { ...testFields, name: ' ' },
        { ...testFields, host: '' },
        { ...testFields, port: 0 },
        { ...testFields, port: 65_536 },
        { ...testFields, port: 12.5 },
        { ...testFields, database: '' },
        { ...testFields, username: '' },
    ]) {
        strict_1.default.throws(() => service.createProfile({ ...invalidFields, password: '', savePasswordSecurely: false }), connectionProfileService_1.ProfileServiceError);
    }
    strict_1.default.equal(service.listProfiles().length, 0);
    database.close();
});
