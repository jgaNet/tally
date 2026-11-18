import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts/routes';
import { registerBudgetRoutes } from './budgets/routes';
import { registerBalanceRoutes } from './balances/routes';
import { openDatabase } from './database';
import { registerExpenseRoutes } from './expenses/routes';
import { registerGroupRoutes } from './groups/routes';
import { registerInvitationRoutes } from './invitations/routes';
import { registerNoticeRoutes } from './notices/routes';
import { registerOperationRoutes } from './operations/routes';
import { registerPayoutAccountRoutes } from './payouts/routes';
import { registerRateRoutes } from './rates/routes';
import { registerRecurringRoutes } from './recurring/routes';
import { recordRecurring } from './recurring/recurring';
import { Refusal } from './refusal';
import { sweepDebts } from './reminders/reminders';
import { registerSettlementRoutes } from './settlements/routes';
import { registerStatementRoutes } from './statements/routes';

/** The running application: what the server entry point and the tests start and stop. */
export interface Application {
  readonly server: FastifyInstance;
  readonly apiPrefix: string;
  /** `http://host:port` once started. */
  readonly address: string;
  /**
   * Starts listening, and the background job, which runs every `jobsIntervalSeconds`. Nothing runs in the
   * background until it is started.
   */
  start(port?: number): Promise<void>;
  /** Stops the background job and the server. */
  stop(): Promise<void>;
  /** One run of the background job, as of `at` (now, when not given). The job runs this on its schedule. */
  runJobs(at?: Date): void;
}

/**
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default), and what
 * it knows is kept in the SQLite file at `databasePath` (`DATABASE_PATH`, else `tally.db`). Payment
 * through the provider is at `providerUrl` (`PROVIDER_URL`) and is refused without it; its webhooks are
 * signed with `providerWebhookSecret` (`PROVIDER_WEBHOOK_SECRET`). The rates offered are asked of the rates
 * service at `ratesUrl` (`RATES_URL`), which is given up after `ratesTimeoutMs` (5 seconds); without it no
 * rate is offered, and a rate an expense states is taken whatever it is. The background job runs every
 * `jobsIntervalSeconds` (`JOBS_INTERVAL_SECONDS`, 60), and a week of debt is `reminderPeriodSeconds`
 * (`REMINDER_PERIOD_SECONDS`, 604800).
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.db',
  providerUrl = process.env.PROVIDER_URL || '',
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET || '',
  providerTimeoutMs = 5000,
  ratesUrl = process.env.RATES_URL || '',
  ratesTimeoutMs = 5000,
  jobsIntervalSeconds = Number(process.env.JOBS_INTERVAL_SECONDS || 60),
  reminderPeriodSeconds = Number(process.env.REMINDER_PERIOD_SECONDS || 604800),
}: {
  apiPrefix?: string;
  port?: number;
  databasePath?: string;
  providerUrl?: string;
  providerWebhookSecret?: string;
  providerTimeoutMs?: number;
  ratesUrl?: string;
  ratesTimeoutMs?: number;
  jobsIntervalSeconds?: number;
  reminderPeriodSeconds?: number;
} = {}): Promise<Application> {
  // Types are checked, not converted: a password sent as a number is a body of the wrong type.
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  const db = openDatabase(databasePath);
  const provider = {
    url: providerUrl.replace(/\/+$/, ''),
    webhookSecret: providerWebhookSecret,
    timeoutMs: providerTimeoutMs,
  };
  const rates = {
    url: ratesUrl.replace(/\/+$/, ''),
    timeoutMs: ratesTimeoutMs,
  };
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
      registerExpenseRoutes(routes, db, rates);
      registerRateRoutes(routes, db, rates);
      registerBudgetRoutes(routes, db);
      registerRecurringRoutes(routes, db);
      registerBalanceRoutes(routes, db);
      registerNoticeRoutes(routes, db);
      registerStatementRoutes(routes, db);
      registerPayoutAccountRoutes(routes, db, provider);
      registerSettlementRoutes(routes, db, provider);
      registerOperationRoutes(routes, db);
    },
    { prefix: `/${apiPrefix}` },
  );

  const reminderPeriodMs = reminderPeriodSeconds * 1000;
  const runJobs = (at: Date = new Date()) => {
    // Each part is its own transaction(s); a failure of one must not keep the other from running.
    let failure: unknown;
    for (const part of [() => recordRecurring(db, at), () => sweepDebts(db, at, reminderPeriodMs)]) {
      try {
        part();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  };
  let job: NodeJS.Timeout | undefined;

  let address = '';
  return {
    server,
    apiPrefix,
    get address() {
      return address;
    },
    async start(listenOn = port) {
      address = await server.listen({ port: listenOn, host: '127.0.0.1' });
      job = setInterval(() => {
        try {
          runJobs();
        } catch (error) {
          // A failed run changes nothing (it is one transaction); the next run tries again.
          server.log.error(error);
        }
      }, jobsIntervalSeconds * 1000);
    },
    async stop() {
      clearInterval(job);
      job = undefined;
      await server.close();
    },
    runJobs,
  };
}
