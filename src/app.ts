import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts/routes';
import { openDatabase } from './database';
import { registerGroupRoutes } from './groups/routes';
import { Refusal } from './refusal';
import { registerOperationRoutes } from './operations/routes';

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
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default), and what
 * it knows is kept in the SQLite file at `databasePath` (`DATABASE_PATH`, else `tally.db`).
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
}: { apiPrefix?: string; port?: number; databasePath?: string } = {}): Promise<Application> {
  // Types are checked, not converted: a password sent as a number is a body of the wrong type.
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  const db = openDatabase(databasePath);
  server.addHook('onClose', async () => {
    db.close();
  });

  server.setErrorHandler((error: FastifyError | Refusal, request, reply) => {
    if (error instanceof Refusal) {
      return reply.code(error.statusCode).send({ type: error.type, message: error.message });
    }
    if (error.validation || error.statusCode === 400) {
      return reply.code(400).send({ type: 'InvalidBody', message: error.message });
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ type: 'InvalidRequest', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ type: 'ServerFailed', message: 'The server failed to answer.' });
  });

  await server.register(cors);
  await server.register(
    async routes => {
      registerAccountRoutes(routes, db);
      registerGroupRoutes(routes, db);
      registerOperationRoutes(routes, db);
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
