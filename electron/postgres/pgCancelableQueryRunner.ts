import {
  Client,
  Query,
  type QueryArrayConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import type {
  PostgresClient,
  PostgresQueryConfig,
  PostgresQueryResult,
} from './postgresConnectionManager';
import type {
  CancellableSelectQuery,
  SelectQueryRunner,
} from './postgresQueryExecutionService';

const CANCEL_CONNECTION_TIMEOUT_MS = 5_000;

interface PgClientWithCancellation extends Client {
  processID?: number;
  secretKey?: number;
}

interface PgCancellationRequester extends Client {
  cancel(client: PgClientWithCancellation, query: Query<QueryResultRow>): void;
}

export class PgCancelableQueryRunner implements SelectQueryRunner {
  start(
    client: PostgresClient,
    config: PostgresQueryConfig,
  ): CancellableSelectQuery {
    if (!(client instanceof Client)) {
      throw new Error('The active PostgreSQL client does not support protocol cancellation.');
    }

    const activeClient = client as PgClientWithCancellation;
    const queryConfig: QueryArrayConfig = {
      text: config.text,
      rowMode: 'array',
      ...(config.values ? { values: config.values } : {}),
    };
    const query = new Query<QueryResultRow>(queryConfig);
    const result = new Promise<PostgresQueryResult>((resolve, reject) => {
      query.once('error', reject);
      query.once('end', (queryResult: QueryResult<QueryResultRow>) => {
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

function sendCancelRequest(
  activeClient: PgClientWithCancellation,
  query: Query<QueryResultRow>,
): Promise<void> {
  if (!Number.isInteger(activeClient.processID) || !Number.isInteger(activeClient.secretKey)) {
    return Promise.reject(new Error('PostgreSQL did not provide a cancellable backend key.'));
  }

  const cancelClient = new Client({
    host: activeClient.host,
    port: activeClient.port,
    ssl: activeClient.ssl,
  });
  const cancellationRequester = cancelClient as PgCancellationRequester;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        cancelClient.connection.once('error', () => undefined);
        try {
          cancelClient.connection.end();
        } catch {
          // The isolated cancel socket may already be closed.
        }
        reject(error);
      } else resolve();
    };
    const onError = () => finish(new Error('The PostgreSQL cancel connection failed.'));
    const timer = setTimeout(
      () => finish(new Error('The PostgreSQL cancel request timed out.')),
      CANCEL_CONNECTION_TIMEOUT_MS,
    );

    cancelClient.connection.once('error', onError);
    cancelClient.connection.once('connect', () => {
      // Client.cancel sends the protocol CancelRequest in its own connect listener.
      queueMicrotask(() => finish());
    });

    try {
      cancellationRequester.cancel(activeClient, query);
    } catch {
      finish(new Error('The PostgreSQL cancel request could not be sent.'));
    }
  });
}
