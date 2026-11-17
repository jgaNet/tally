import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts';
import { registerBalanceRoutes } from './balances';
import { openDatabase } from './database';
import { registerExpenseRoutes } from './expenses';
import { registerGroupRoutes } from './groups';
import { registerHistoryRoutes } from './history';
import { registerInvitationRoutes } from './invitations';
import { registerLeaveRoutes } from './leaving';
import { registerOperationRoutes } from './operations';
import { registerPayoutAccountRoutes } from './payout-accounts';
import { registerSettlementRoutes } from './settlements';
import { type ProviderConfig } from './provider';
import { Refusal } from './refusal';
import { registerProviderWebhookRoutes } from './webhooks';

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
 * knows is kept in the SQLite file at `databasePath`. The payment provider is reached at `providerUrl`, and
 * its webhooks are signed with `providerWebhookSecret`; `providerTimeoutMs` is how long it may take to answer.
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
  providerUrl = process.env.PROVIDER_URL || undefined,
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET || undefined,
  providerTimeoutMs = 5000,
}: {
  apiPrefix?: string;
  port?: number;
  databasePath?: string;
  providerUrl?: string;
  providerWebhookSecret?: string;
  providerTimeoutMs?: number;
} = {}): Promise<Application> {
  const provider: ProviderConfig = {
    url: providerUrl,
    webhookSecret: providerWebhookSecret,
    timeoutMs: providerTimeoutMs,
  };
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
      registerPayoutAccountRoutes(instance, db, provider);
      registerGroupRoutes(instance, db);
      registerInvitationRoutes(instance, db);
      registerLeaveRoutes(instance, db);
      registerExpenseRoutes(instance, db);
      registerBalanceRoutes(instance, db);
      registerHistoryRoutes(instance, db);
      registerSettlementRoutes(instance, db, provider);
      registerProviderWebhookRoutes(instance, db, provider);
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
