"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionProfileRepository = void 0;
const profileColumns = `
  id, name, host, port, database_name, username, environment,
  encrypted_password, created_at, updated_at
`;
class ConnectionProfileRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    list() {
        const rows = this.database
            .prepare(`
        SELECT ${profileColumns}
        FROM connection_profiles
        ORDER BY lower(name), created_at
      `)
            .all();
        return rows.map(mapRow);
    }
    findById(id) {
        const row = this.database
            .prepare(`
        SELECT ${profileColumns}
        FROM connection_profiles
        WHERE id = ?
      `)
            .get(id);
        return row ? mapRow(row) : undefined;
    }
    create(profile) {
        this.database.prepare(`
      INSERT INTO connection_profiles (
        id, name, host, port, database_name, username, environment,
        encrypted_password, created_at, updated_at
      ) VALUES (
        @id, @name, @host, @port, @databaseName, @username, @environment,
        @encryptedPassword, @createdAt, @updatedAt
      )
    `).run(toParameters(profile));
        return profile;
    }
    update(profile) {
        const result = this.database.prepare(`
      UPDATE connection_profiles
      SET name = @name,
          host = @host,
          port = @port,
          database_name = @databaseName,
          username = @username,
          environment = @environment,
          encrypted_password = @encryptedPassword,
          updated_at = @updatedAt
      WHERE id = @id
    `).run(toParameters(profile));
        if (result.changes !== 1)
            throw new Error('Connection profile was not found.');
        return profile;
    }
    delete(id) {
        const result = this.database
            .prepare('DELETE FROM connection_profiles WHERE id = ?')
            .run(id);
        return result.changes === 1;
    }
}
exports.ConnectionProfileRepository = ConnectionProfileRepository;
function mapRow(row) {
    return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        database: row.database_name,
        username: row.username,
        environment: row.environment,
        encryptedPassword: row.encrypted_password,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function toParameters(profile) {
    return {
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        databaseName: profile.database,
        username: profile.username,
        environment: profile.environment,
        encryptedPassword: profile.encryptedPassword,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    };
}
