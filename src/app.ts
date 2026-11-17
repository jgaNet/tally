import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts';
import { openDatabase } from './database';
import { registerGroupRoutes } from './groups';
import { registerOperationRoutes } from './operations';
import { Refusal } from './refusal';

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
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default), and what it
 * knows is kept in the SQLite file at `databasePath`.
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
}: { apiPrefix?: string; port?: number; databasePath?: string } = {}): Promise<Application> {
  const db = openDatabase(databasePath);
  // Only the JSON the requests name is accepted: a value of another type is refused, never coerced.
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof Refusal)
      return reply.code(error.statusCode).send({ type: error.type, message: error.message });
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ type: 'InvalidRequest', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ type: 'ServerFailure', message: 'The server failed to answer.' });
  });
  await server.register(cors);
  await server.register(
    async instance => {
      registerAccountRoutes(instance, db);
      registerGroupRoutes(instance, db);
      registerOperationRoutes(instance, db);
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
      try {
        await server.close();
      } finally {
        db.close();
      }
    },
  };
}
