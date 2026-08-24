"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProfileFields = validateProfileFields;
exports.hasValidationErrors = hasValidationErrors;
const connectionProfiles_1 = require("./connectionProfiles");
function validateProfileFields(fields) {
    const errors = {};
    if (!fields.name.trim())
        errors.name = 'Connection name is required.';
    if (!fields.host.trim())
        errors.host = 'Host is required.';
    if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65_535) {
        errors.port = 'Port must be an integer from 1 to 65535.';
    }
    if (!fields.database.trim())
        errors.database = 'Database is required.';
    if (!fields.username.trim())
        errors.username = 'Username is required.';
    if (!(0, connectionProfiles_1.isConnectionEnvironment)(fields.environment))
        errors.environment = 'Select a supported environment.';
    return errors;
}
function hasValidationErrors(errors) {
    return Object.keys(errors).length > 0;
}
