"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POSTGRES_CONNECTION_CHANNELS = void 0;
exports.POSTGRES_CONNECTION_CHANNELS = {
    test: 'postgres-connection:test',
    connect: 'postgres-connection:connect',
    disconnect: 'postgres-connection:disconnect',
    getState: 'postgres-connection:get-state',
    stateChanged: 'postgres-connection:state-changed',
};
