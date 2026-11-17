import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { openDatabase } from './database';
import { sendError } from './http';
import { registerAccountRoutes } from './routes/accounts';
import { registerGroupRoutes } from './routes/groups';
import { registerOperationRoutes } from './routes/operations';

/** The running application: what the server entry point and the tests start and stop. */
export interface Application {
  readonly server: FastifyInstance;
  readonly apiPrefix: string;
  /** `http://host:port` once started. */
  readonly address: string;
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default). What the
 * application knows is kept in the SQLite file at `databasePath` (`DATABASE_PATH`, `tally.db` by default).
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
}: { apiPrefix?: string; port?: number; databasePath?: string } = {}): Promise<Application> {
  const db = openDatabase(databasePath);
  // A body's values are checked by the rules, not coerced: a number where a string is due is a `400`.
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  server.addHook('onClose', async () => {
    db.close();
  });
  server.setErrorHandler(sendError);
  await server.register(cors);
  await server.register(
    async api => {
      registerAccountRoutes(api, db);
      registerGroupRoutes(api, db);
      registerOperationRoutes(api, db);
    },
    { prefix: `/${apiPrefix}` },
  );

  let address = '';
  return {
    server,
    apiPrefix,
    get address() {
      return address;
    },
    async start(listenOn = port) {
      address = await server.listen({ port: listenOn, host: '127.0.0.1' });
    },
    async stop() {
      await server.close();
    },
  };
}
