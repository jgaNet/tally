import cors from '@fastify/cors';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts';
import { registerAuditRoutes } from './audit';
import { registerArchiveRoutes } from './archive';
import { registerBalanceRoutes } from './balances';
import { registerBudgetRoutes } from './budgets';
import { openDatabase, type Database } from './database';
import { registerExpenseRoutes } from './expenses';
import { registerGroupRoutes } from './groups';
import { registerHistoryRoutes } from './history';
import { registerInvitationRoutes } from './invitations';
import { registerLeaveRoutes } from './leaving';
import { registerMergeRoutes } from './merge';
import { registerNoticeRoutes } from './notices';
import { registerOperationRoutes } from './operations';
import { registerPayoutAccountRoutes } from './payout-accounts';
import { registerRateRoutes, type RatesConfig } from './rates';
import { registerReceiptRoutes, type ReceiptsConfig } from './receipts';
import { registerRecurringRoutes, runRecurring } from './recurring';
import { registerSettlementRoutes } from './settlements';
import { registerTemplateRoutes } from './templates';
import { type ProviderConfig } from './provider';
import { Refusal } from './refusal';
import { DEFAULT_REMINDER_PERIOD_SECONDS, runReminders } from './reminders';
import { registerProviderWebhookRoutes } from './webhooks';

/** The running application: what the server entry point and the tests start and stop. */
export interface Application {
  readonly server: FastifyInstance;
  readonly apiPrefix: string;
  /** `http://host:port` once started. */
  readonly address: string;
  /** One run of the background job, at `now` (the present by default). The server runs it by itself every `JOBS_INTERVAL_SECONDS`. */
  runJobs(now?: Date): Promise<void>;
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default), and what it
 * knows is kept in the PostgreSQL database at `databaseUrl`. A `databasePath` naming a SQLite file Tally kept is
 * moved into an empty database first (see `openDatabase`). The payment provider is reached at `providerUrl`, and
 * its webhooks are signed with `providerWebhookSecret`; `providerTimeoutMs` is how long it may take to answer.
 * The rates service is reached at `ratesUrl`, for `ratesTimeoutMs` at most; without it, no rate is offered.
 * The receipts store is reached at `receiptsUrl`, for `receiptsTimeoutMs` at most; without it, no receipt is kept.
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databaseUrl = process.env.DATABASE_URL,
  databasePath = process.env.DATABASE_PATH || undefined,
  providerUrl = process.env.PROVIDER_URL || undefined,
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET || undefined,
  providerTimeoutMs = 5000,
  ratesUrl = process.env.RATES_URL || undefined,
  ratesTimeoutMs = 5000,
  receiptsUrl = process.env.RECEIPTS_URL || undefined,
  receiptsTimeoutMs = 5000,
  jobsIntervalSeconds = positiveNumber(process.env.JOBS_INTERVAL_SECONDS, 60),
  reminderPeriodSeconds = positiveNumber(process.env.REMINDER_PERIOD_SECONDS, DEFAULT_REMINDER_PERIOD_SECONDS),
}: {
  apiPrefix?: string;
  port?: number;
  databaseUrl?: string;
  databasePath?: string;
  providerUrl?: string;
  providerWebhookSecret?: string;
  providerTimeoutMs?: number;
  ratesUrl?: string;
  ratesTimeoutMs?: number;
  receiptsUrl?: string;
  receiptsTimeoutMs?: number;
  jobsIntervalSeconds?: number;
  reminderPeriodSeconds?: number;
} = {}): Promise<Application> {
  const provider: ProviderConfig = {
    url: providerUrl,
    webhookSecret: providerWebhookSecret,
    timeoutMs: providerTimeoutMs,
  };
  const rates: RatesConfig = { url: ratesUrl, timeoutMs: ratesTimeoutMs };
  const receipts: ReceiptsConfig = { url: receiptsUrl, timeoutMs: receiptsTimeoutMs };
  if (!databaseUrl) throw new Error('DATABASE_URL must name the PostgreSQL database of Tally.');
  const db: Database = await openDatabase(databaseUrl, databasePath);
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
      registerArchiveRoutes(instance, db);
      registerMergeRoutes(instance, db);
      registerInvitationRoutes(instance, db);
      registerLeaveRoutes(instance, db);
      registerExpenseRoutes(instance, db, rates);
      registerReceiptRoutes(instance, db, receipts);
      registerRateRoutes(instance, db, rates);
      registerRecurringRoutes(instance, db);
      registerBudgetRoutes(instance, db);
      registerTemplateRoutes(instance, db);
      registerBalanceRoutes(instance, db);
      registerHistoryRoutes(instance, db);
      registerSettlementRoutes(instance, db, provider);
      registerProviderWebhookRoutes(instance, db, provider);
      registerNoticeRoutes(instance, db);
      registerAuditRoutes(instance, db);
      registerOperationRoutes(instance, db);
    },
    { prefix: `/${apiPrefix}` },
  );

  let address = '';
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  // The background job of the server: one run at a time, so a run that is slower than the interval is not joined by the next.
  let running: Promise<void> = Promise.resolve();
  let queued = false;
  const runJobs = async (now?: Date): Promise<void> => {
    if (stopped) return;
    await runRecurring(db, now);
    if (stopped) return;
    await runReminders(db, reminderPeriodSeconds * 1000, now);
  };
  return {
    server,
    apiPrefix,
    get address() {
      return address;
    },
    runJobs,
    async start(listenOn = port) {
      address = await server.listen({ port: listenOn, host: '127.0.0.1' });
      timer ??= setInterval(() => {
        // One run waits at most: a tick while a run is still queued adds nothing.
        if (queued) return;
        queued = true;
        running = running.then(async () => {
          queued = false;
          try {
            await runJobs();
          } catch (error) {
            server.log.error(error);
          }
        });
      }, jobsIntervalSeconds * 1000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        await server.close();
        await running;
      } finally {
        await db.close();
      }
    },
  };
}
