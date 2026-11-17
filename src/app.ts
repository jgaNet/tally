import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts/routes';
import { registerBalanceRoutes } from './balances/routes';
import { openDatabase } from './database';
import { registerExpenseRoutes } from './expenses/routes';
import { registerGroupRoutes } from './groups/routes';
import { registerInvitationRoutes } from './invitations/routes';
import { Refusal } from './refusal';
import { registerOperationRoutes } from './operations/routes';
import { registerSettlementRoutes } from './settlements/routes';
import { registerStatementRoutes } from './statements/routes';

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
 * it knows is kept in the SQLite file at `databasePath` (`DATABASE_PATH`, else `tally.db`). Payment
 * through the provider is at `providerUrl` (`PROVIDER_URL`) and is refused without it; its webhooks are
 * signed with `providerWebhookSecret` (`PROVIDER_WEBHOOK_SECRET`).
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
  providerUrl = process.env.PROVIDER_URL || '',
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET || '',
  providerTimeoutMs = 5000,
}: {
  apiPrefix?: string;
  port?: number;
  databasePath?: string;
  providerUrl?: string;
  providerWebhookSecret?: string;
  providerTimeoutMs?: number;
} = {}): Promise<Application> {
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
      registerInvitationRoutes(routes, db);
      registerExpenseRoutes(routes, db);
      registerBalanceRoutes(routes, db);
      registerStatementRoutes(routes, db);
      registerSettlementRoutes(routes, db, {
        url: providerUrl.replace(/\/+$/, ''),
        webhookSecret: providerWebhookSecret,
        timeoutMs: providerTimeoutMs,
      });
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
