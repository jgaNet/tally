import { EventEmitter } from 'events';

import { Logger, relayOutbox } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { PostgresInbox } from '@Architecture/Infrastructure/Postgres/PostgresInbox';
import { Role } from '@SharedKernel/Domain';

import { prepareDatabase } from '@Bootstrap/Database/prepareDatabase';
import { LEGACY_UPGRADES } from '@Bootstrap/Database/legacy';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { operationRoutes } from '@Bootstrap/Fastify/operations.routes';
import { localGroupsModule, authenticatedAccountOf } from '@Contexts/Groups/module.local';
import { localLedgerModule, sweepRecurringExpenseDays } from '@Contexts/Ledger/module.local';
import { recurringRoutes } from '@Contexts/Ledger/Presentation/recurring.routes';
import { budgetRoutes } from '@Contexts/Ledger/Presentation/budgets.routes';
import { auditRoutes } from '@Contexts/Ledger/Presentation/audit.routes';
import { templateRoutes } from '@Contexts/Ledger/Presentation/templates.routes';
import { receiptRoutes } from '@Contexts/Ledger/Presentation/receipts.routes';
import { localSettlementsModule } from '@Contexts/Settlements/module.local';
import { localNotificationsModule, sweepNotificationDebts } from '@Contexts/Notifications/module.local';
import { expenseRoutes } from '@Contexts/Ledger/Presentation/expenses.routes';
import { accountRoutes } from '@Contexts/Groups/Presentation/accounts.routes';
import { groupRoutes } from '@Contexts/Groups/Presentation/groups.routes';
import { invitationRoutes } from '@Contexts/Groups/Presentation/invitations.routes';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/notices.routes';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/settlements.routes';
import { nettingRoutes } from '@Contexts/Settlements/Presentation/nettings.routes';
import { providerWebhookRoutes } from '@Contexts/Settlements/Presentation/providerWebhooks.routes';

/**
 * The composition root of the application (docs/adr/0002, docs/adr/0029). It prepares the application's PostgreSQL
 * database before it serves (moving into it what the SQLite file named by `DATABASE_PATH` held, the first time), sets
 * up the transport, which gives each request its trace, its caller and its own unit of work over that database, and the
 * bus that carries what the contexts tell each other, relayed from the outbox after each commit. It
 * registers the contexts' modules and their routes under their prefixes, and the background job that
 * relays the outbox every `JOBS_INTERVAL_SECONDS` (60 when unset).
 *
 * Configuration is in the environment: `PORT`, `API_PREFIX` (`v1`), `DATABASE_URL` (the PostgreSQL database), `DATABASE_PATH` (a SQLite file an earlier version kept, moved in once),
 * `JOBS_INTERVAL_SECONDS` (60), `REMINDER_PERIOD_SECONDS` (604800, a week), `WEB_ORIGINS` (a comma-separated list), and for payments through the provider (request 13):
 * `PROVIDER_URL`, the base of the provider's API without a trailing slash, and `PROVIDER_WEBHOOK_SECRET`, the secret it signs with;
 * and for the rate offered for an expense in another currency (request 22): `RATES_URL`, the base of the rates service's API without a
 * trailing slash, where no value means no rates service; and for receipts (request 26): `RECEIPTS_URL`, the base of the receipts store's
 * API without a trailing slash, where no value means every receipt is refused.
 *
 * A context is added here: its `LiteModule` registered, its routes under its own prefix with `{ module }`, or at the
 * API's root when it serves more than one resource (docs/adr/0003):
 *
 *   .registerModule(localTasksModule)
 *   .registerRoutes('/tasks', taskRoutes, { module: localTasksModule });
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
}: { logger?: Logger; apiPrefix?: string; port?: number; webOrigins?: string[] } = {}): Promise<FastifyApplication> {
  await prepareDatabase(sharedDatabase, { legacyPath: process.env.DATABASE_PATH, legacyUpgrades: LEGACY_UPGRADES });
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    unitOfWork: () => new PostgresUnitOfWork(sharedDatabase),
    // The token a request brings proves its account: the Groups context says which, and every other request is anonymous.
    authenticate: async request => {
      const subjectId = authenticatedAccountOf(request.headers.authorization);
      if (subjectId) request.auth = { subjectId, role: Role.USER };
    },
  })
    .setEventBus(
      new InMemoryEventBus({
        eventEmitter: new EventEmitter(),
        clock: systemClock,
        inbox: new PostgresInbox(sharedDatabase),
      }),
    )
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerModule(localSettlementsModule)
    .registerModule(localNotificationsModule)
    .registerRoutes('/', accountRoutes, { module: localGroupsModule })
    .registerRoutes('/', groupRoutes, { module: localGroupsModule })
    .registerRoutes('/', invitationRoutes, { module: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { module: localLedgerModule })
    .registerRoutes('/', recurringRoutes, { module: localLedgerModule })
    .registerRoutes('/', budgetRoutes, { module: localLedgerModule })
    .registerRoutes('/', auditRoutes, { module: localLedgerModule })
    .registerRoutes('/', templateRoutes, { module: localLedgerModule })
    .registerRoutes('/', receiptRoutes, { module: localLedgerModule })
    .registerRoutes('/', settlementRoutes, { module: localSettlementsModule })
    .registerRoutes('/', nettingRoutes, { module: localSettlementsModule })
    .registerRoutes('/', providerWebhookRoutes, { module: localSettlementsModule })
    .registerRoutes('/', noticeRoutes, { module: localNotificationsModule })
    .registerRoutes('/', operationRoutes, {});

  await app.startModules();

  // What a previous run made durable and did not publish goes out now (ADR 24), and then at every job's run.
  const relay = () =>
    relayOutbox(new PostgresUnitOfWork(sharedDatabase).outbox, app.getEventBus(), app.executionContext('relay'));
  await relay();
  app.onStop(() => sharedDatabase.close());
  app.every(Number(process.env.JOBS_INTERVAL_SECONDS || 60) * 1000, relay);
  // Each run of the background job also sweeps the debts of every group, for the reminders (request 18, docs/adr/0018).
  const reminderPeriodMs = Number(process.env.REMINDER_PERIOD_SECONDS || 604800) * 1000;
  app.every(Number(process.env.JOBS_INTERVAL_SECONDS || 60) * 1000, () =>
    sweepNotificationDebts(app.executionContext('sweep'), reminderPeriodMs),
  );
  // Each run of the background job also records the days that have come for recurring expenses (request 23, docs/adr/0022).
  app.every(Number(process.env.JOBS_INTERVAL_SECONDS || 60) * 1000, () =>
    sweepRecurringExpenseDays(app.executionContext('recurring')),
  );
  return app;
}
