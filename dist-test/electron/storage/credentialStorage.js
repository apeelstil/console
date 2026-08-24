"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElectronCredentialStorage = void 0;
const electron_1 = require("electron");
class ElectronCredentialStorage {
    isEncryptionAvailable() {
        return electron_1.safeStorage.isEncryptionAvailable();
    }
    encrypt(password) {
        return electron_1.safeStorage.encryptString(password);
    }
    decrypt(encryptedPassword) {
        return electron_1.safeStorage.decryptString(encryptedPassword);
    }
}
exports.ElectronCredentialStorage = ElectronCredentialStorage;
