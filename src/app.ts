import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './routes/admin';
import { registerAuditRoutes } from './routes/audit';
import { administratorEmailsOf } from './administrators';
import { openDatabase } from './database';
import { sendError } from './http';
import type { ProviderConfig } from './provider';
import { recordRecurring } from './recurring';
import { DEFAULT_REMINDER_PERIOD_SECONDS, sweepReminders } from './reminders';
import { registerAccountRoutes } from './routes/accounts';
import { registerBalanceRoutes } from './routes/balances';
import { registerBudgetRoutes } from './routes/budgets';
import { registerExpenseRoutes } from './routes/expenses';
import { registerGroupRoutes } from './routes/groups';
import { registerInvitationRoutes } from './routes/invitations';
import { registerNoticeRoutes } from './routes/notices';
import { registerNoticePreferenceRoutes } from './routes/notice-preferences';
import { registerNettingRoutes } from './routes/nettings';
import { registerOperationRoutes } from './routes/operations';
import { registerPayoutAccountRoutes } from './routes/payout-accounts';
import { registerProviderRoutes } from './routes/provider';
import { registerReceiptRoutes } from './routes/receipts';
import { registerRecurringRoutes } from './routes/recurring';
import { registerRateRoutes } from './routes/rates';
import { registerSettlementRoutes } from './routes/settlements';
import { registerStatementRoutes } from './routes/statements';
import { registerTemplateRoutes } from './routes/templates';
import type { RatesConfig } from './rates';
import type { ReceiptsConfig } from './receipts';

/** The running application: what the server entry point and the tests start and stop. */
export interface Application {
  readonly server: FastifyInstance;
  readonly apiPrefix: string;
  /** `http://host:port` once started. */
  readonly address: string;
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
  /** One run of the background job, at the application's clock: what the timer does every interval. */
  runJobs(): Promise<void>;
}

/** A positive number of seconds from the environment, or `fallback` when it is not set or not one. */
function secondsFrom(value: string | undefined, fallback: number): number {
  const seconds = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/**
 * Builds the application. Every route is served under `/<apiPrefix>` (`/v1` by default). What the application knows is
 * kept in the PostgreSQL database at `databaseUrl` (`DATABASE_URL`, required): the database must exist; its schema is
 * created when missing. A database that holds nothing of Tally's yet, with the SQLite file `databasePath` (`DATABASE_PATH`)
 * named, first takes every row of that file (see `openDatabase`).
 * Settlements through the payment provider need `providerUrl` (`PROVIDER_URL`), the base of the provider's API,
 * and the webhooks it sends are verified with `providerWebhookSecret` (`PROVIDER_WEBHOOK_SECRET`); without the
 * URL, paying through the provider is refused. The provider has `providerTimeoutMs` (5000 by default) to answer.
 *
 * Once started, the background job runs every `jobsIntervalSeconds` (`JOBS_INTERVAL_SECONDS`, 60 by default): it
 * records the expenses of recurring expenses that have come due, and reminds whoever has owed too much in a group for
 * `reminderPeriodSeconds` (`REMINDER_PERIOD_SECONDS`, a week by default), at the time `clock` tells.
 *
 * The rates an expense in another currency is recorded at are asked of the rates service at `ratesUrl` (`RATES_URL`), the
 * base of its API; without it no rate is offered, and a rate given is taken as it is. The service has `ratesTimeoutMs`
 * (5000 by default) to answer.
 *
 * The receipts attached to expenses are kept in the receipts store at `receiptsUrl` (`RECEIPTS_URL`), the base of its API;
 * without it, attaching a receipt is refused. The store has `receiptsTimeoutMs` (5000 by default) to answer.
 *
 * The administrators are the accounts whose email is one of `adminEmails` (`ADMIN_EMAILS`, a list separated by commas,
 * whatever its case). They decide the settlements contested by their payees, and suspend and reinstate accounts (see
 * `routes/admin.ts` and `suspensions.ts`).
 */
export async function createApplication({
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databaseUrl = process.env.DATABASE_URL,
  databasePath = process.env.DATABASE_PATH,
  providerUrl = process.env.PROVIDER_URL,
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET,
  providerTimeoutMs = 5000,
  ratesUrl = process.env.RATES_URL,
  ratesTimeoutMs = 5000,
  receiptsUrl = process.env.RECEIPTS_URL,
  receiptsTimeoutMs = 5000,
  adminEmails = process.env.ADMIN_EMAILS,
  jobsIntervalSeconds = secondsFrom(process.env.JOBS_INTERVAL_SECONDS, 60),
  reminderPeriodSeconds = secondsFrom(process.env.REMINDER_PERIOD_SECONDS, DEFAULT_REMINDER_PERIOD_SECONDS),
  clock = () => new Date(),
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
  adminEmails?: string;
  jobsIntervalSeconds?: number;
  reminderPeriodSeconds?: number;
  clock?: () => Date;
} = {}): Promise<Application> {
  // An empty value is no value: no file to move, and no database is a mistake.
  if (!databaseUrl) throw new Error('DATABASE_URL names the PostgreSQL database Tally keeps its state in.');
  const db = await openDatabase({ url: databaseUrl, legacyPath: databasePath || undefined });
  const administrators = administratorEmailsOf(adminEmails);
  // An empty value is no value: the provider is not configured.
  const provider: ProviderConfig = {
    url: providerUrl || undefined,
    webhookSecret: providerWebhookSecret || undefined,
    timeoutMs: providerTimeoutMs,
  };
  // An empty value is no value: no rates service is configured.
  const rates: RatesConfig = { url: ratesUrl || undefined, timeoutMs: ratesTimeoutMs };
  // An empty value is no value: no receipts store is configured.
  const receipts: ReceiptsConfig = { url: receiptsUrl || undefined, timeoutMs: receiptsTimeoutMs };
  // A body's values are checked by the rules, not coerced: a number where a string is due is a `400`.
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  let jobsTimer: NodeJS.Timeout | undefined;
  const runJobs = async () => {
    await recordRecurring(db, clock());
    await sweepReminders(db, clock(), reminderPeriodSeconds * 1000);
  };
  server.addHook('onClose', async () => {
    clearInterval(jobsTimer);
    jobsTimer = undefined;
    await db.close();
  });
  server.setErrorHandler(sendError);
  await server.register(cors);
  await server.register(
    async api => {
      registerAccountRoutes(api, db);
      registerGroupRoutes(api, db);
      registerInvitationRoutes(api, db);
      registerExpenseRoutes(api, db, rates);
      registerReceiptRoutes(api, db, receipts);
      registerRateRoutes(api, db, rates);
      registerRecurringRoutes(api, db, clock);
      registerBudgetRoutes(api, db, clock);
      registerBalanceRoutes(api, db);
      registerStatementRoutes(api, db);
      registerSettlementRoutes(api, db, provider);
      registerNettingRoutes(api, db);
      registerProviderRoutes(api, db, provider);
      registerPayoutAccountRoutes(api, db, provider);
      registerNoticeRoutes(api, db);
      registerNoticePreferenceRoutes(api, db);
      registerTemplateRoutes(api, db);
      registerOperationRoutes(api, db);
      registerAuditRoutes(api, db);
      registerAdminRoutes(api, db, administrators);
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
      jobsTimer ??= setInterval(() => {
        runJobs().catch(error => {
          // A run that fails (another server holding the database too long) changes nothing: the next one tries again.
          server.log.error(error);
        });
      }, jobsIntervalSeconds * 1000);
      jobsTimer.unref();
    },
    async stop() {
      await server.close();
    },
    runJobs,
  };
}
