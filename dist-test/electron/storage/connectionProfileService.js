"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionProfileService = exports.ProfileServiceError = void 0;
const node_crypto_1 = require("node:crypto");
const profileValidation_1 = require("../../shared/profileValidation");
class ProfileServiceError extends Error {
    safeMessage;
    constructor(safeMessage) {
        super(safeMessage);
        this.safeMessage = safeMessage;
        this.name = 'ProfileServiceError';
    }
}
exports.ProfileServiceError = ProfileServiceError;
class ConnectionProfileService {
    repository;
    credentials;
    constructor(repository, credentials) {
        this.repository = repository;
        this.credentials = credentials;
    }
    listProfiles() {
        return this.repository.list().map(toPublicProfile);
    }
    createProfile(input) {
        const fields = normalizeFields(input);
        assertValidFields(fields);
        let encryptedPassword = null;
        if (input.savePasswordSecurely) {
            encryptedPassword = this.encryptPassword(input.password);
        }
        const timestamp = new Date().toISOString();
        const stored = this.repository.create({
            id: (0, node_crypto_1.randomUUID)(),
            ...fields,
            encryptedPassword,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        return toPublicProfile(stored);
    }
    updateProfile(input) {
        const current = this.repository.findById(input.id);
        if (!current)
            throw new ProfileServiceError('The selected connection profile no longer exists.');
        const fields = normalizeFields(input);
        assertValidFields(fields);
        let encryptedPassword = current.encryptedPassword;
        if (input.passwordUpdate.mode === 'remove') {
            encryptedPassword = null;
        }
        else if (input.passwordUpdate.mode === 'replace') {
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
    deleteProfile(id) {
        if (!this.repository.delete(id)) {
            throw new ProfileServiceError('The selected connection profile no longer exists.');
        }
    }
    encryptPassword(password) {
        if (!password)
            throw new ProfileServiceError('Enter a password before enabling secure password saving.');
        if (!this.credentials.isEncryptionAvailable()) {
            throw new ProfileServiceError('Windows credential encryption is unavailable. The password was not saved. Disable secure password saving and try again.');
        }
        try {
            return this.credentials.encrypt(password);
        }
        catch {
            throw new ProfileServiceError('The password could not be encrypted and was not saved.');
        }
    }
}
exports.ConnectionProfileService = ConnectionProfileService;
function normalizeFields(fields) {
    return {
        name: fields.name.trim(),
        host: fields.host.trim(),
        port: fields.port,
        database: fields.database.trim(),
        username: fields.username.trim(),
        environment: fields.environment,
    };
}
function assertValidFields(fields) {
    if ((0, profileValidation_1.hasValidationErrors)((0, profileValidation_1.validateProfileFields)(fields))) {
        throw new ProfileServiceError('Check the required connection profile fields and try again.');
    }
}
function toPublicProfile(profile) {
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
