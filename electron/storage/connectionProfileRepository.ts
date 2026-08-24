import type Database from 'better-sqlite3';
import type { ConnectionEnvironment, ConnectionProfileFields } from '../../shared/connectionProfiles';

interface ConnectionProfileRow {
  id: string;
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  environment: ConnectionEnvironment;
  created_at: string;
  updated_at: string;
}

export interface StoredConnectionProfile extends ConnectionProfileFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface InsertProfileParameters {
  id: string;
  name: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  environment: ConnectionEnvironment;
  createdAt: string;
  updatedAt: string;
}

type UpdateProfileParameters = InsertProfileParameters;

const profileColumns = `
  id, name, host, port, database_name, username, environment,
  created_at, updated_at
`;

export class ConnectionProfileRepository {
  constructor(private readonly database: Database.Database) {}

  list(): StoredConnectionProfile[] {
    const rows = this.database
      .prepare<[], ConnectionProfileRow>(`
        SELECT ${profileColumns}
        FROM connection_profiles
        ORDER BY lower(name), created_at
      `)
      .all();

    return rows.map(mapRow);
  }

  findById(id: string): StoredConnectionProfile | undefined {
    const row = this.database
      .prepare<[string], ConnectionProfileRow>(`
        SELECT ${profileColumns}
        FROM connection_profiles
        WHERE id = ?
      `)
      .get(id);

    return row ? mapRow(row) : undefined;
  }

  create(profile: StoredConnectionProfile): StoredConnectionProfile {
    this.database.prepare<InsertProfileParameters>(`
      INSERT INTO connection_profiles (
        id, name, host, port, database_name, username, environment,
        created_at, updated_at
      ) VALUES (
        @id, @name, @host, @port, @databaseName, @username, @environment,
        @createdAt, @updatedAt
      )
    `).run(toParameters(profile));

    return profile;
  }

  update(profile: StoredConnectionProfile): StoredConnectionProfile {
    const result = this.database.prepare<UpdateProfileParameters>(`
      UPDATE connection_profiles
      SET name = @name,
          host = @host,
          port = @port,
          database_name = @databaseName,
          username = @username,
          environment = @environment,
          updated_at = @updatedAt
      WHERE id = @id
    `).run(toParameters(profile));

    if (result.changes !== 1) throw new Error('Connection profile was not found.');
    return profile;
  }

  delete(id: string): boolean {
    const result = this.database
      .prepare<[string]>('DELETE FROM connection_profiles WHERE id = ?')
      .run(id);
    return result.changes === 1;
  }
}

function mapRow(row: ConnectionProfileRow): StoredConnectionProfile {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    database: row.database_name,
    username: row.username,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toParameters(profile: StoredConnectionProfile): InsertProfileParameters {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    databaseName: profile.database,
    username: profile.username,
    environment: profile.environment,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
