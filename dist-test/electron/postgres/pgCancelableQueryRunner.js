"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PgCancelableQueryRunner = void 0;
const pg_1 = require("pg");
const CANCEL_CONNECTION_TIMEOUT_MS = 5_000;
class PgCancelableQueryRunner {
    start(client, config) {
        if (!(client instanceof pg_1.Client)) {
            throw new Error('The active PostgreSQL client does not support protocol cancellation.');
        }
        const activeClient = client;
        const queryConfig = {
            text: config.text,
            rowMode: 'array',
            ...(config.values ? { values: config.values } : {}),
        };
        const query = new pg_1.Query(queryConfig);
        const result = new Promise((resolve, reject) => {
            query.once('error', reject);
            query.once('end', (queryResult) => {
                resolve({
                    rows: queryResult.rows,
                    fields: queryResult.fields,
                    rowCount: queryResult.rowCount,
                });
            });
        });
        activeClient.query(query);
        return {
            result,
            requestCancel: () => sendCancelRequest(activeClient, query),
        };
    }
}
exports.PgCancelableQueryRunner = PgCancelableQueryRunner;
function sendCancelRequest(activeClient, query) {
    if (!Number.isInteger(activeClient.processID) || !Number.isInteger(activeClient.secretKey)) {
        return Promise.reject(new Error('PostgreSQL did not provide a cancellable backend key.'));
    }
    const cancelClient = new pg_1.Client({
        host: activeClient.host,
        port: activeClient.port,
        ssl: activeClient.ssl,
    });
    const cancellationRequester = cancelClient;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                cancelClient.connection.once('error', () => undefined);
                try {
                    cancelClient.connection.end();
                }
                catch {
                    // The isolated cancel socket may already be closed.
                }
                reject(error);
            }
            else
                resolve();
        };
        const onError = () => finish(new Error('The PostgreSQL cancel connection failed.'));
        const timer = setTimeout(() => finish(new Error('The PostgreSQL cancel request timed out.')), CANCEL_CONNECTION_TIMEOUT_MS);
        cancelClient.connection.once('error', onError);
        cancelClient.connection.once('connect', () => {
            // Client.cancel sends the protocol CancelRequest in its own connect listener.
            queueMicrotask(() => finish());
        });
        try {
            cancellationRequester.cancel(activeClient, query);
        }
        catch {
            finish(new Error('The PostgreSQL cancel request could not be sent.'));
        }
    });
}
