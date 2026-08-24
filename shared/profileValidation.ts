import type { ConnectionProfileFields } from './connectionProfiles';
import { isConnectionEnvironment } from './connectionProfiles';

export type ProfileFieldErrors = Partial<Record<keyof ConnectionProfileFields | 'password', string>>;

export function validateProfileFields(fields: ConnectionProfileFields): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};

  if (!fields.name.trim()) errors.name = 'Укажите название подключения.';
  if (!fields.host.trim()) errors.host = 'Укажите хост.';
  if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65_535) {
    errors.port = 'Порт должен быть целым числом от 1 до 65535.';
  }
  if (!fields.database.trim()) errors.database = 'Укажите базу данных.';
  if (!fields.username.trim()) errors.username = 'Укажите имя пользователя.';
  if (!isConnectionEnvironment(fields.environment)) errors.environment = 'Выберите поддерживаемое окружение.';

  return errors;
}

export function hasValidationErrors(errors: ProfileFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
