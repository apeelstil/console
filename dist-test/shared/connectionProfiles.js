"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONNECTION_PROFILE_CHANNELS = exports.CONNECTION_ENVIRONMENTS = void 0;
exports.isConnectionEnvironment = isConnectionEnvironment;
exports.isProductionEnvironment = isProductionEnvironment;
exports.CONNECTION_ENVIRONMENTS = ['PROD', 'TEST', 'DEV', 'OTHER'];
exports.CONNECTION_PROFILE_CHANNELS = {
    list: 'connection-profiles:list',
    create: 'connection-profiles:create',
    update: 'connection-profiles:update',
    delete: 'connection-profiles:delete',
};
function isConnectionEnvironment(value) {
    return typeof value === 'string' && exports.CONNECTION_ENVIRONMENTS.includes(value);
}
function isProductionEnvironment(environment) {
    return environment === 'PROD';
}
