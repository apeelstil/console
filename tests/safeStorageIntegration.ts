import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { ConnectionProfileRepository } from '../electron/storage/connectionProfileRepository';
import { ConnectionProfileService } from '../electron/storage/connectionProfileService';
import { ElectronCredentialStorage } from '../electron/storage/credentialStorage';
import { initializeDatabase } from '../electron/storage/database';

void app.whenReady().then(() => {
  const testDirectory = mkdtempSync(path.join(tmpdir(), 'supra-safe-storage-'));
  const database = initializeDatabase(path.join(testDirectory, 'safe-storage.db'));

  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Electron safeStorage must be available on Windows');

    const repository = new ConnectionProfileRepository(database);
    const service = new ConnectionProfileService(repository, new ElectronCredentialStorage());
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

    assert.ok(ciphertext);
    assert.equal(ciphertext.includes(Buffer.from(plaintextPassword)), false);
    assert.equal(profile.hasStoredPassword, true);
    assert.equal('password' in profile, false);
    assert.equal('encryptedPassword' in profile, false);
    process.stdout.write(`Electron safeStorage integration: passed (Node ${process.versions.node}, ABI ${process.versions.modules})\n`);
  } catch {
    process.stderr.write('Electron safeStorage integration: failed\n');
    process.exitCode = 1;
  } finally {
    database.close();
    rmSync(testDirectory, { recursive: true, force: true });
    app.quit();
  }
});
