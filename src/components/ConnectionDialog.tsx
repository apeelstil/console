import { useEffect, useState, type FormEvent } from 'react';
import {
  CONNECTION_ENVIRONMENTS,
  type ConnectionEnvironment,
  type ConnectionProfile,
  type ConnectionProfileFields,
  type IpcResult,
  type PasswordUpdate,
} from '../../shared/connectionProfiles';
import type { ConnectionRequest, ConnectionState } from '../../shared/postgresConnection';
import { hasValidationErrors, validateProfileFields, type ProfileFieldErrors } from '../../shared/profileValidation';
import { USER_MESSAGES } from '../../shared/userMessages';
import type { ConnectionDraft } from '../types/connection';
import { PasswordInput } from './PasswordInput';

interface ConnectionDialogProps {
  onClose: () => void;
  onEnvironmentChange: (environment: ConnectionEnvironment) => void;
  connectionState: ConnectionState;
  onConnected: () => void;
}

interface Notice {
  kind: 'error' | 'info' | 'success';
  message: string;
}

const initialConnection: ConnectionDraft = {
  name: '',
  host: '',
  port: '5432',
  database: '',
  username: '',
  password: '',
  environment: 'DEV',
  saveProfile: false,
  savePasswordSecurely: false,
};

export function ConnectionDialog({ onClose, onEnvironmentChange, connectionState, onConnected }: ConnectionDialogProps) {
  const [connection, setConnection] = useState<ConnectionDraft>(initialConnection);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [removeStoredPassword, setRemoveStoredPassword] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectionAction, setConnectionAction] = useState<'testing' | 'connecting' | null>(null);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!window.supraDesktop) {
        if (active) {
          setNotice({ kind: 'error', message: 'Хранилище профилей доступно только в Electron-приложении.' });
          setLoading(false);
        }
        return;
      }

      try {
        const result = await window.supraDesktop.listProfiles();
        if (!active) return;
        if (result.ok) setProfiles(result.data);
        else setNotice({ kind: 'error', message: result.error });
      } catch {
        if (active) setNotice({ kind: 'error', message: 'Локальное хранилище профилей не отвечает.' });
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => { active = false; };
  }, []);

  const update = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setConnection((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    if (key === 'environment') onEnvironmentChange(value as ConnectionEnvironment);
    if (key === 'password' && value) setRemoveStoredPassword(false);
  };

  const startNewProfile = () => {
    setConnection(initialConnection);
    setSelectedProfileId(null);
    setRemoveStoredPassword(false);
    setConfirmingDelete(false);
    setErrors({});
    setNotice(null);
    onEnvironmentChange(initialConnection.environment);
  };

  const selectProfile = (profile: ConnectionProfile) => {
    setSelectedProfileId(profile.id);
    setConnection({
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      database: profile.database,
      username: profile.username,
      password: '',
      environment: profile.environment,
      saveProfile: true,
      savePasswordSecurely: profile.hasStoredPassword,
    });
    setRemoveStoredPassword(false);
    setConfirmingDelete(false);
    setErrors({});
    setNotice(null);
    onEnvironmentChange(profile.environment);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);

    if (!connection.saveProfile) {
      setNotice({ kind: 'info', message: 'Включите «Сохранить профиль», чтобы записать параметры подключения локально.' });
      return;
    }

    const fields = toProfileFields(connection);
    const nextErrors = validateProfileFields(fields);
    const hasExistingPassword = selectedProfile?.hasStoredPassword === true && !removeStoredPassword;
    if (connection.savePasswordSecurely && !connection.password && !hasExistingPassword) {
      nextErrors.password = 'Введите пароль для безопасного сохранения.';
    }
    setErrors(nextErrors);
    if (hasValidationErrors(nextErrors)) return;

    const api = window.supraDesktop;
    if (!api) {
      setNotice({ kind: 'error', message: USER_MESSAGES.localProfileStorageUnavailable });
      return;
    }

    setSaving(true);
    try {
      const result = selectedProfile
        ? await api.updateProfile({
            id: selectedProfile.id,
            ...fields,
            passwordUpdate: getPasswordUpdate(connection, removeStoredPassword),
          })
        : await api.createProfile({
            ...fields,
            password: connection.password,
            savePasswordSecurely: connection.savePasswordSecurely,
          });

      if (!result.ok) {
        setNotice({ kind: 'error', message: result.error });
        return;
      }

      const savedProfile = result.data;
      setProfiles((current) => sortProfiles([
        ...current.filter((profile) => profile.id !== savedProfile.id),
        savedProfile,
      ]));
      selectProfile(savedProfile);
      setNotice({ kind: 'success', message: selectedProfile ? 'Профиль подключения обновлён.' : 'Профиль подключения сохранён.' });
    } catch {
      setNotice({ kind: 'error', message: 'Локальное хранилище профилей не отвечает.' });
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async () => {
    if (!selectedProfile || !window.supraDesktop) return;
    setSaving(true);
    let result: IpcResult<{ id: string }>;
    try {
      result = await window.supraDesktop.deleteProfile(selectedProfile.id);
    } catch {
      setNotice({ kind: 'error', message: 'Локальное хранилище профилей не отвечает.' });
      setConfirmingDelete(false);
      setSaving(false);
      return;
    }
    setSaving(false);

    if (!result.ok) {
      setNotice({ kind: 'error', message: result.error });
      setConfirmingDelete(false);
      return;
    }

    setProfiles((current) => current.filter((profile) => profile.id !== selectedProfile.id));
    startNewProfile();
    setNotice({ kind: 'success', message: 'Профиль подключения и сохранённый пароль удалены.' });
  };

  const runConnectionAction = async (action: 'testing' | 'connecting') => {
    setNotice(null);
    const fields = toProfileFields(connection);
    const nextErrors = validateProfileFields(fields);
    const canUseStoredPassword = selectedProfile?.hasStoredPassword === true && !removeStoredPassword;
    if (!connection.password && !canUseStoredPassword) {
      nextErrors.password = 'Введите пароль для этого подключения.';
    }
    setErrors(nextErrors);
    if (hasValidationErrors(nextErrors)) return;

    const api = window.supraDesktop;
    if (!api) {
      setNotice({ kind: 'error', message: USER_MESSAGES.databaseConnectionUnavailable });
      return;
    }

    const request = toConnectionRequest(connection, selectedProfile);
    setConnectionAction(action);
    setNotice({ kind: 'info', message: action === 'testing' ? 'Проверка…' : 'Подключение…' });
    try {
      if (action === 'testing') {
        const result = await api.testConnection(request);
        if (result.ok) {
          setNotice({ kind: 'success', message: `${result.data.message} (${result.data.durationMs} мс)` });
        } else {
          setNotice({ kind: 'error', message: result.error });
        }
        return;
      }

      const result = await api.connect(request);
      if (!result.ok) {
        setNotice({ kind: 'error', message: result.error });
        return;
      }
      setConnection((current) => ({ ...current, password: '' }));
      setNotice({ kind: 'success', message: USER_MESSAGES.connected });
      onConnected();
    } catch {
      setNotice({ kind: 'error', message: 'Операция подключения к PostgreSQL не отвечает.' });
    } finally {
      setConnectionAction(null);
    }
  };

  const connectionBusy = connectionAction !== null
    || connectionState.status === 'TESTING'
    || connectionState.status === 'CONNECTING';

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <div className="dialog-header">
          <div><h2 id="connection-title">Профили подключений</h2><p>Локальные параметры PostgreSQL</p></div>
          <button type="button" className="close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="connection-content">
          <aside className="profiles-pane">
            <div className="profiles-heading"><strong>Сохранённые подключения</strong><button type="button" onClick={startNewProfile} aria-label="Новый профиль">＋</button></div>
            <div className="profiles-list">
              {loading && <p className="profile-empty">Загрузка профилей…</p>}
              {!loading && profiles.length === 0 && <p className="profile-empty">Нет сохранённых подключений</p>}
              {profiles.map((profile) => (
                <button
                  type="button"
                  className={`profile-item ${selectedProfileId === profile.id ? 'active' : ''}`}
                  key={profile.id}
                  onClick={() => selectProfile(profile)}
                >
                  <span className={`environment-badge ${profile.environment.toLowerCase()}`}>{profile.environment}</span>
                  <span className="profile-summary"><strong>{profile.name}</strong><small>{profile.host}:{profile.port}</small></span>
                  {profile.hasStoredPassword && <span className="profile-lock" title="Пароль сохранён безопасно">●</span>}
                </button>
              ))}
            </div>
            <button type="button" className="new-profile" onClick={startNewProfile}>Новый профиль</button>
          </aside>

          <form onSubmit={saveProfile} className="profile-form">
            <div className="form-caption">
              <strong>{selectedProfile ? 'Изменить подключение' : 'Новое подключение'}</strong>
              {selectedProfile && <small>Сохранено {formatDate(selectedProfile.updatedAt)}</small>}
            </div>
            <div className="form-grid">
              <Field label="Название подключения" error={errors.name} className="full">
                <input value={connection.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(errors.name)} placeholder="Моя база данных" />
              </Field>
              <Field label="Среда" error={errors.environment} className="environment full">
                <select value={connection.environment} onChange={(event) => update('environment', event.target.value as ConnectionEnvironment)}>
                  {CONNECTION_ENVIRONMENTS.map((environment) => <option key={environment}>{environment}</option>)}
                </select>
              </Field>
              <Field label="Хост" error={errors.host} className="host">
                <input value={connection.host} onChange={(event) => update('host', event.target.value)} aria-invalid={Boolean(errors.host)} placeholder="Имя хоста" />
              </Field>
              <Field label="Порт" error={errors.port}>
                <input value={connection.port} inputMode="numeric" onChange={(event) => update('port', event.target.value)} aria-invalid={Boolean(errors.port)} />
              </Field>
              <Field label="База данных" error={errors.database} className="full">
                <input value={connection.database} onChange={(event) => update('database', event.target.value)} aria-invalid={Boolean(errors.database)} placeholder="Название базы данных" />
              </Field>
              <Field label="Пользователь" error={errors.username} className="full">
                <input value={connection.username} onChange={(event) => update('username', event.target.value)} aria-invalid={Boolean(errors.username)} autoComplete="off" placeholder="Имя пользователя" />
              </Field>
              <Field label={selectedProfile?.hasStoredPassword ? 'Новый пароль' : 'Пароль'} error={errors.password} className="full">
                <PasswordInput value={connection.password} onChange={(event) => update('password', event.target.value)} aria-invalid={Boolean(errors.password)} autoComplete="new-password" placeholder={selectedProfile?.hasStoredPassword ? 'Оставьте пустым, чтобы сохранить текущий пароль' : 'Пароль'} />
              </Field>
            </div>

            {selectedProfile?.hasStoredPassword && !removeStoredPassword && (
              <div className="password-state"><span>✓ Пароль сохранён безопасно</span><button type="button" onClick={() => { setRemoveStoredPassword(true); update('savePasswordSecurely', false); }}>Удалить сохранённый пароль</button></div>
            )}
            {removeStoredPassword && (
              <div className="password-state remove"><span>Сохранённый пароль будет удалён</span><button type="button" onClick={() => { setRemoveStoredPassword(false); update('savePasswordSecurely', true); }}>Отменить</button></div>
            )}

            <label className="check"><input type="checkbox" checked={connection.saveProfile} onChange={(event) => update('saveProfile', event.target.checked)} /> Сохранить профиль</label>
            <label className="check"><input type="checkbox" checked={connection.savePasswordSecurely} disabled={removeStoredPassword} onChange={(event) => update('savePasswordSecurely', event.target.checked)} /> Сохранить пароль безопасно</label>

            {notice && <div className={`notice ${notice.kind}`} role="status">ⓘ {notice.message}</div>}

            {confirmingDelete && selectedProfile && (
              <div className="delete-confirmation">
                <span>Удалить «{selectedProfile.name}» и сохранённый пароль?</span>
                <div><button type="button" className="danger" disabled={saving} onClick={() => void deleteProfile()}>Удалить</button><button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>Отмена</button></div>
              </div>
            )}

            <div className="dialog-actions">
              {selectedProfile && !confirmingDelete && <button type="button" className="danger-link" onClick={() => setConfirmingDelete(true)}>Удалить профиль</button>}
              <span className="action-spacer" />
              <button type="button" onClick={() => void runConnectionAction('testing')} disabled={saving || connectionBusy} className="secondary">{connectionAction === 'testing' ? 'Проверка…' : 'Проверить подключение'}</button>
              <button type="submit" disabled={saving || connectionBusy}>{saving ? 'Сохранение…' : selectedProfile ? 'Сохранить изменения' : 'Сохранить профиль'}</button>
              <button type="button" onClick={() => void runConnectionAction('connecting')} disabled={saving || connectionBusy}>{connectionAction === 'connecting' ? 'Подключение…' : 'Подключиться'}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

function Field({ label, error, className, children }: FieldProps) {
  return <label className={className}>{label}{children}{error && <small className="field-error">{error}</small>}</label>;
}

function toProfileFields(connection: ConnectionDraft): ConnectionProfileFields {
  return {
    name: connection.name,
    host: connection.host,
    port: Number(connection.port),
    database: connection.database,
    username: connection.username,
    environment: connection.environment,
  };
}

function getPasswordUpdate(connection: ConnectionDraft, removeStoredPassword: boolean): PasswordUpdate {
  if (removeStoredPassword) return { mode: 'remove' };
  if (connection.password && connection.savePasswordSecurely) {
    return { mode: 'replace', password: connection.password };
  }
  return { mode: 'keep' };
}

function toConnectionRequest(connection: ConnectionDraft, selectedProfile?: ConnectionProfile): ConnectionRequest {
  if (selectedProfile) {
    return {
      source: 'profile',
      profileId: selectedProfile.id,
      ...(connection.password ? { temporaryPassword: connection.password } : {}),
    };
  }
  return {
    source: 'temporary',
    connection: toProfileFields(connection),
    temporaryPassword: connection.password,
  };
}

function sortProfiles(profiles: ConnectionProfile[]): ConnectionProfile[] {
  return [...profiles].sort((first, second) => first.name.localeCompare(second.name));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
