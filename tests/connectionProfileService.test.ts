import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { ConnectionProfileRepository } from '../electron/storage/connectionProfileRepository';
import { ConnectionProfileService, ProfileServiceError } from '../electron/storage/connectionProfileService';
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

function createFileDatabase() {
  databaseSequence += 1;
  const databasePath = path.join(testDirectory, `profiles-${databaseSequence}.db`);
  return { databasePath, database: initializeDatabase(databasePath) };
}

test('profile metadata persists after restart without a password column or password DTO fields', () => {
  const { databasePath, database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const inputWithIgnoredSecret = { ...testFields, password: 'must-never-be-stored' };
  const created = service.createProfile(inputWithIgnoredSecret);
  database.close();

  const reopenedDatabase = initializeDatabase(databasePath);
  const reopenedService = new ConnectionProfileService(new ConnectionProfileRepository(reopenedDatabase));
  const profiles = reopenedService.listProfiles();
  const columns = reopenedDatabase.pragma('table_info(connection_profiles)') as Array<{ name: string }>;

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.id, created.id);
  assert.equal(profiles[0]?.host, testFields.host);
  assert.equal('password' in (profiles[0] ?? {}), false);
  assert.equal('hasStoredPassword' in (profiles[0] ?? {}), false);
  assert.equal(columns.some((column) => column.name === 'encrypted_password'), false);
  assert.equal(reopenedDatabase.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);
  reopenedDatabase.close();
});

test('all non-secret profile fields continue to be saved and updated', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const created = service.createProfile(testFields);
  const updated = service.updateProfile({
    ...testFields,
    id: created.id,
    name: 'SUPRA TEST EDITED',
    host: 'edited-host',
    port: 5433,
    database: 'edited_database',
    username: 'edited_user',
    environment: 'DEV',
  });

  assert.deepEqual(
    {
      name: updated.name,
      host: updated.host,
      port: updated.port,
      database: updated.database,
      username: updated.username,
      environment: updated.environment,
    },
    {
      name: 'SUPRA TEST EDITED',
      host: 'edited-host',
      port: 5433,
      database: 'edited_database',
      username: 'edited_user',
      environment: 'DEV',
    },
  );
  database.close();
});

test('deleting one profile leaves other profiles untouched', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const first = service.createProfile(testFields);
  const second = service.createProfile({ ...testFields, name: 'SUPRA DEV', environment: 'DEV' });

  service.deleteProfile(first.id);

  assert.deepEqual(service.listProfiles().map((profile) => profile.id), [second.id]);
  database.close();
});

test('PROD environment still activates the production UI condition', () => {
  assert.equal(isProductionEnvironment('PROD'), true);
  assert.equal(isProductionEnvironment('TEST'), false);
  assert.equal(isProductionEnvironment('DEV'), false);
  assert.equal(isProductionEnvironment('OTHER'), false);
});

test('SQLite constraints and service validation reject invalid metadata', () => {
  const { database } = createFileDatabase();
  const service = new ConnectionProfileService(new ConnectionProfileRepository(database));

  for (const invalidFields of [
    { ...testFields, name: ' ' },
    { ...testFields, host: '' },
    { ...testFields, port: 0 },
    { ...testFields, port: 65_536 },
    { ...testFields, port: 12.5 },
    { ...testFields, database: '' },
    { ...testFields, username: '' },
  ]) {
    assert.throws(() => service.createProfile(invalidFields), ProfileServiceError);
  }
  assert.equal(service.listProfiles().length, 0);
  database.close();
});
