import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { openDatabase } from './database';
import { sendError } from './http';
import type { ProviderConfig } from './provider';
import { registerAccountRoutes } from './routes/accounts';
import { registerBalanceRoutes } from './routes/balances';
import { registerExpenseRoutes } from './routes/expenses';
import { registerGroupRoutes } from './routes/groups';
import { registerInvitationRoutes } from './routes/invitations';
import { registerOperationRoutes } from './routes/operations';
import { registerProviderRoutes } from './routes/provider';
import { registerSettlementRoutes } from './routes/settlements';
import { registerStatementRoutes } from './routes/statements';

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
 * Settlements through the payment provider need `providerUrl` (`PROVIDER_URL`), the base of the provider's API,
 * and the webhooks it sends are verified with `providerWebhookSecret` (`PROVIDER_WEBHOOK_SECRET`); without the
 * URL, paying through the provider is refused. The provider has `providerTimeoutMs` (5000 by default) to answer.
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
  providerUrl = process.env.PROVIDER_URL,
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET,
  providerTimeoutMs = 5000,
}: {
  apiPrefix?: string;
  port?: number;
  databasePath?: string;
  providerUrl?: string;
  providerWebhookSecret?: string;
  providerTimeoutMs?: number;
} = {}): Promise<Application> {
  const db = openDatabase(databasePath);
  // An empty value is no value: the provider is not configured.
  const provider: ProviderConfig = {
    url: providerUrl || undefined,
    webhookSecret: providerWebhookSecret || undefined,
    timeoutMs: providerTimeoutMs,
  };
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
      registerInvitationRoutes(api, db);
      registerExpenseRoutes(api, db);
      registerBalanceRoutes(api, db);
      registerStatementRoutes(api, db);
      registerSettlementRoutes(api, db, provider);
      registerProviderRoutes(api, db, provider);
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
