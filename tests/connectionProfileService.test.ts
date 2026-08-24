import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { ConnectionProfileRepository } from '../electron/storage/connectionProfileRepository';
import { ConnectionProfileService, ProfileServiceError } from '../electron/storage/connectionProfileService';
import type { CredentialStorage } from '../electron/storage/credentialStorage';
import { CURRENT_SCHEMA_VERSION, initializeDatabase } from '../electron/storage/database';
import { isProductionEnvironment, type ConnectionProfileFields } from '../shared/connectionProfiles';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'supra-query-console-'));
let databaseSequence = 0;

after(() => rmSync(testDirectory, { recursive: true, force: true }));

const testFields: ConnectionProfileFields = {
  name: 'SUPRA TEST',
  host: 'test-host',
  port: 5432,
  database: 'supra_test',
  username: 'support_user',
  environment: 'TEST',
};

class FakeCredentialStorage implements CredentialStorage {
  private sequence = 0;

  constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encrypt(password: string): Buffer {
    void password;
    this.sequence += 1;
    return Buffer.from(`test-cipher-${this.sequence}`);
  }

  decrypt(encryptedPassword: Buffer): string {
    void encryptedPassword;
    throw new Error('Decryption is not used by profile management.');
  }
}

function createFileDatabase() {
  databaseSequence += 1;
  const databasePath = path.join(testDirectory, `profiles-${databaseSequence}.db`);
  return { databasePath, database: initializeDatabase(databasePath) };
}

test('Scenario A: profile metadata persists after closing and reopening SQLite', () => {
  const { databasePath, database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database), new FakeCredentialStorage());
  const created = service.createProfile({ ...testFields, password: '', savePasswordSecurely: false });
  database.close();

  const reopenedDatabase = initializeDatabase(databasePath);
  const reopenedService = new ConnectionProfileService(new ConnectionProfileRepository(reopenedDatabase), new FakeCredentialStorage());
  const profiles = reopenedService.listProfiles();

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.id, created.id);
  assert.equal(profiles[0]?.hasStoredPassword, false);
  assert.equal(reopenedDatabase.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);
  reopenedDatabase.close();
});

test('Scenario B: public profile exposes only hasStoredPassword, never password or ciphertext', () => {
  const { database } = createFileDatabase();
  const repository = new ConnectionProfileRepository(database);
  const service = new ConnectionProfileService(repository, new FakeCredentialStorage());
  const profile = service.createProfile({ ...testFields, password: 'not-returned', savePasswordSecurely: true });

  assert.equal(profile.hasStoredPassword, true);
  assert.equal('password' in profile, false);
  assert.equal('encryptedPassword' in profile, false);
  assert.equal('encrypted_password' in profile, false);
  assert.notEqual(repository.findById(profile.id)?.encryptedPassword, null);
  database.close();
});

test('Scenario C: metadata update keeps existing encrypted password when password mode is keep', () => {
  const { database } = createFileDatabase();
  const repository = new ConnectionProfileRepository(database);
  const service = new ConnectionProfileService(repository, new FakeCredentialStorage());
  const created = service.createProfile({ ...testFields, password: 'first-password', savePasswordSecurely: true });
  const originalCiphertext = Buffer.from(repository.findById(created.id)?.encryptedPassword ?? []);

  const updated = service.updateProfile({
    ...testFields,
    id: created.id,
    name: 'SUPRA TEST EDITED',
    passwordUpdate: { mode: 'keep' },
  });

  assert.equal(updated.name, 'SUPRA TEST EDITED');
  assert.equal(updated.hasStoredPassword, true);
  assert.deepEqual(repository.findById(created.id)?.encryptedPassword, originalCiphertext);
  database.close();
});

test('Scenario D: replacing a password replaces the old ciphertext', () => {
  const { database } = createFileDatabase();
  const repository = new ConnectionProfileRepository(database);
  const service = new ConnectionProfileService(repository, new FakeCredentialStorage());
  const created = service.createProfile({ ...testFields, password: 'first-password', savePasswordSecurely: true });
  const originalCiphertext = Buffer.from(repository.findById(created.id)?.encryptedPassword ?? []);

  service.updateProfile({
    ...testFields,
    id: created.id,
    passwordUpdate: { mode: 'replace', password: 'second-password' },
  });

  assert.notDeepEqual(repository.findById(created.id)?.encryptedPassword, originalCiphertext);
  database.close();
});

test('Scenario E: deleting one profile removes it and leaves other profiles untouched', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database), new FakeCredentialStorage());
  const first = service.createProfile({ ...testFields, password: 'stored', savePasswordSecurely: true });
  const second = service.createProfile({ ...testFields, name: 'SUPRA DEV', environment: 'DEV', password: '', savePasswordSecurely: false });

  service.deleteProfile(first.id);
  const profiles = service.listProfiles();

  assert.deepEqual(profiles.map((profile) => profile.id), [second.id]);
  database.close();
});

test('Scenario F: PROD environment activates the production UI condition', () => {
  assert.equal(isProductionEnvironment('PROD'), true);
  assert.equal(isProductionEnvironment('TEST'), false);
  assert.equal(isProductionEnvironment('DEV'), false);
  assert.equal(isProductionEnvironment('OTHER'), false);
});

test('secure password saving fails closed when encryption is unavailable', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database), new FakeCredentialStorage(false));

  assert.throws(
    () => service.createProfile({ ...testFields, password: 'must-not-be-stored', savePasswordSecurely: true }),
    (error: unknown) => error instanceof ProfileServiceError && error.safeMessage.includes('unavailable'),
  );
  assert.equal(service.listProfiles().length, 0);
  database.close();
});

test('SQLite constraints and service validation reject invalid metadata', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database), new FakeCredentialStorage());

  for (const invalidFields of [
    { ...testFields, name: ' ' },
    { ...testFields, host: '' },
    { ...testFields, port: 0 },
    { ...testFields, port: 65_536 },
    { ...testFields, port: 12.5 },
    { ...testFields, database: '' },
    { ...testFields, username: '' },
  ]) {
    assert.throws(
      () => service.createProfile({ ...invalidFields, password: '', savePasswordSecurely: false }),
      ProfileServiceError,
    );
  }
  assert.equal(service.listProfiles().length, 0);
  database.close();
});
