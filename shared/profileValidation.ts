import type { ConnectionProfileFields } from './connectionProfiles';
import { isConnectionEnvironment } from './connectionProfiles';

export type ProfileFieldErrors = Partial<Record<keyof ConnectionProfileFields | 'password', string>>;

export function validateProfileFields(fields: ConnectionProfileFields): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};

  if (!fields.name.trim()) errors.name = 'Connection name is required.';
  if (!fields.host.trim()) errors.host = 'Host is required.';
  if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65_535) {
    errors.port = 'Port must be an integer from 1 to 65535.';
  }
  if (!fields.database.trim()) errors.database = 'Database is required.';
  if (!fields.username.trim()) errors.username = 'Username is required.';
  if (!isConnectionEnvironment(fields.environment)) errors.environment = 'Select a supported environment.';

  return errors;
}

export function hasValidationErrors(errors: ProfileFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
