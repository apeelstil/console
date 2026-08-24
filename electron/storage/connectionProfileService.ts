import { randomUUID } from 'node:crypto';
import type {
  ConnectionProfile,
  ConnectionProfileFields,
  CreateConnectionProfileInput,
  UpdateConnectionProfileInput,
} from '../../shared/connectionProfiles';
import { hasValidationErrors, validateProfileFields } from '../../shared/profileValidation';
import type { CredentialStorage } from './credentialStorage';
import type { ConnectionProfileRepository, StoredConnectionProfile } from './connectionProfileRepository';

export class ProfileServiceError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'ProfileServiceError';
  }
}

export class ConnectionProfileService {
  constructor(
    private readonly repository: ConnectionProfileRepository,
    private readonly credentials: CredentialStorage,
  ) {}

  listProfiles(): ConnectionProfile[] {
    return this.repository.list().map(toPublicProfile);
  }

  createProfile(input: CreateConnectionProfileInput): ConnectionProfile {
    const fields = normalizeFields(input);
    assertValidFields(fields);

    let encryptedPassword: Buffer | null = null;
    if (input.savePasswordSecurely) {
      encryptedPassword = this.encryptPassword(input.password);
    }

    const timestamp = new Date().toISOString();
    const stored = this.repository.create({
      id: randomUUID(),
      ...fields,
      encryptedPassword,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return toPublicProfile(stored);
  }

  updateProfile(input: UpdateConnectionProfileInput): ConnectionProfile {
    const current = this.repository.findById(input.id);
    if (!current) throw new ProfileServiceError('Выбранный профиль подключения больше не существует.');

    const fields = normalizeFields(input);
    assertValidFields(fields);

    let encryptedPassword = current.encryptedPassword;
    if (input.passwordUpdate.mode === 'remove') {
      encryptedPassword = null;
    } else if (input.passwordUpdate.mode === 'replace') {
      encryptedPassword = this.encryptPassword(input.passwordUpdate.password);
    }

    const stored = this.repository.update({
      ...current,
      ...fields,
      encryptedPassword,
      updatedAt: new Date().toISOString(),
    });

    return toPublicProfile(stored);
  }

  deleteProfile(id: string): void {
    if (!this.repository.delete(id)) {
      throw new ProfileServiceError('Выбранный профиль подключения больше не существует.');
    }
  }

  private encryptPassword(password: string): Buffer {
    if (!password) throw new ProfileServiceError('Введите пароль перед включением безопасного сохранения.');
    if (!this.credentials.isEncryptionAvailable()) {
      throw new ProfileServiceError(
        'Шифрование учётных данных Windows недоступно. Пароль не сохранён. Отключите безопасное сохранение и повторите попытку.',
      );
    }

    try {
      return this.credentials.encrypt(password);
    } catch {
      throw new ProfileServiceError('Не удалось зашифровать пароль; пароль не сохранён.');
    }
  }
}

function normalizeFields(fields: ConnectionProfileFields): ConnectionProfileFields {
  return {
    name: fields.name.trim(),
    host: fields.host.trim(),
    port: fields.port,
    database: fields.database.trim(),
    username: fields.username.trim(),
    environment: fields.environment,
  };
}

function assertValidFields(fields: ConnectionProfileFields): void {
  if (hasValidationErrors(validateProfileFields(fields))) {
    throw new ProfileServiceError('Проверьте обязательные поля профиля подключения и повторите попытку.');
  }
}

function toPublicProfile(profile: StoredConnectionProfile): ConnectionProfile {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    username: profile.username,
    environment: profile.environment,
    hasStoredPassword: profile.encryptedPassword !== null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
