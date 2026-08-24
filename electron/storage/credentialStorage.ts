import { safeStorage } from 'electron';

export interface CredentialStorage {
  isEncryptionAvailable(): boolean;
  encrypt(password: string): Buffer;
  decrypt(encryptedPassword: Buffer): string;
}

export class ElectronCredentialStorage implements CredentialStorage {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(password: string): Buffer {
    return safeStorage.encryptString(password);
  }

  decrypt(encryptedPassword: Buffer): string {
    return safeStorage.decryptString(encryptedPassword);
  }
}
