"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MUTATION_TRANSACTION_CHANNELS = void 0;
exports.MUTATION_TRANSACTION_CHANNELS = {
    prepare: 'mutation-transaction:prepare',
    execute: 'mutation-transaction:execute',
    commit: 'mutation-transaction:commit',
    rollback: 'mutation-transaction:rollback',
    getState: 'mutation-transaction:get-state',
    stateChanged: 'mutation-transaction:state-changed',
};
