"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUERY_EXECUTION_CHANNELS = void 0;
exports.QUERY_EXECUTION_CHANNELS = {
    executeSelect: 'query-execution:execute-select',
    cancelSelect: 'query-execution:cancel-select',
    getState: 'query-execution:get-state',
    stateChanged: 'query-execution:state-changed',
};
