import { EventEmitter } from 'events';

import { randomUUID } from 'crypto';

import { Logger, relayOutbox } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { PostgresOutbox } from '@Architecture/Infrastructure/Outbox/PostgresOutbox';
import { PostgresInbox } from '@Architecture/Infrastructure/EventBus/PostgresInbox';
import { PostgresDatabase, databaseUrl } from '@Architecture/Infrastructure/DataSources/PostgresDatabase';
import { prepareStorage } from '@Bootstrap/Storage/storage';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { database as groupsDatabase, groupsAccessTokens, localGroupsModule } from '@Contexts/Groups/module.local';
import { accountRoutes } from '@Contexts/Groups/Presentation/accounts.routes';
import { groupRoutes } from '@Contexts/Groups/Presentation/groups.routes';
import { authenticateWith } from '@Contexts/Groups/Presentation/authentication';
import { database as ledgerDatabase, localLedgerModule } from '@Contexts/Ledger/module.local';
import { sweepRecurringExpenses } from '@Contexts/Ledger/Application/RecurringExpenses';
import { auditRoutes } from '@Contexts/Ledger/Presentation/audit.routes';
import { budgetRoutes } from '@Contexts/Ledger/Presentation/budgets.routes';
import { templateRoutes } from '@Contexts/Ledger/Presentation/templates.routes';
import { recurringRoutes } from '@Contexts/Ledger/Presentation/recurring.routes';
import {
  database as settlementsDatabase,
  localSettlementsModule,
  providerSignedBy,
} from '@Contexts/Settlements/module.local';
import { database as notificationsDatabase, localNotificationsModule } from '@Contexts/Notifications/module.local';
import { expenseRoutes } from '@Contexts/Ledger/Presentation/expenses.routes';
import { sweepDebts } from '@Contexts/Notifications/Application/Reminders';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/notices.routes';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/settlements.routes';

/**
 * The composition root an application created Lite starts from (ADR 40): `clean-ddd create --profile
 * lite` gives it as `src/Bootstrap/Fastify/createApplication.ts`. It knows no context, not even the
 * Tracker: a Lite command is answered at once by its use case, so there is no operation to follow.
 * What it sets up is what every context will share — the transport, which gives each request its trace,
 * its caller and its unit of work, and the bus that carries what the contexts tell each other, relayed
 * from the outbox after each commit. Nobody signs in here: every caller is anonymous until a context
 * that owns accounts gives the transport its `authenticate`.
 *
 * A context is added here: its `LiteModule` registered, its routes under its own prefix, the module in
 * the routes' options (the Groups' accounts and groups are served at the root of the API: `/v1/accounts`, `/v1/groups`) —
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
  await prepareStorage([groupsDatabase, ledgerDatabase, settlementsDatabase, notificationsDatabase]);
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate: authenticateWith(groupsAccessTokens),
  })
    .setEventBus(
      new InMemoryEventBus({
        eventEmitter: new EventEmitter(),
        clock: systemClock,
        inbox: new PostgresInbox(PostgresDatabase.of(databaseUrl())),
      }),
    )
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerModule(localSettlementsModule)
    .registerModule(localNotificationsModule)
    .registerRoutes('/', accountRoutes, { module: localGroupsModule })
    .registerRoutes('/', groupRoutes, { module: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { module: localLedgerModule })
    .registerRoutes('/', recurringRoutes, { module: localLedgerModule })
    .registerRoutes('/', budgetRoutes, { module: localLedgerModule })
    .registerRoutes('/', auditRoutes, { module: localLedgerModule })
    .registerRoutes('/', templateRoutes, { module: localLedgerModule })
    .registerRoutes('/', settlementRoutes, { module: localSettlementsModule, providerSignedBy })
    .registerRoutes('/', noticeRoutes, { module: localNotificationsModule });

  await app.startModules();
  runEvery(jobsIntervalMs, app, logger, async () => {
    // A run of the background job (request 1): the recurring expenses whose day came record their expense (request 23), then the
    // debts that last are noted and reminded (request 18). Each runs in a context of its own, with no caller.
    const recorded = await localLedgerModule
      .useCase(sweepRecurringExpenses)
      .run(undefined, app.executionContext(`job-${randomUUID()}`));
    const reminded = await localNotificationsModule
      .useCase(sweepDebts)
      .run(undefined, app.executionContext(`job-${randomUUID()}`));
    return recorded.isFailure() ? recorded : reminded;
  });
  // What a previous run made durable and did not publish goes out now (ADR 24): nothing, with an
  // in-memory outbox, and the line is where a store's outbox would be relayed.
  await relayOutbox(
    new PostgresOutbox(PostgresDatabase.of(databaseUrl())),
    app.getEventBus(),
    app.executionContext('startup'),
  );
  app.fastify.addHook('onClose', () => PostgresDatabase.closeAll());
  return app;
}

/** `JOBS_INTERVAL_SECONDS` seconds, 60 when that is not set (to a number above 0); read when the application is built. */
function jobsIntervalMs(): number {
  const seconds = Number(process.env.JOBS_INTERVAL_SECONDS);
  return (seconds > 0 && Number.isFinite(seconds) ? seconds : 60) * 1000;
}

/**
 * The background job (request 1): `run` at every interval, never two at once in this process, a failure logged and the next run
 * made all the same. The timer does not keep the process alive, and stops with the application. Several servers on one database
 * each run it: what a run decides is held by what it saves (CONC-OPTIMISTIC), not by who runs it.
 */
function runEvery(
  intervalOf: () => number,
  app: FastifyApplication,
  logger: Logger,
  run: () => Promise<{ isFailure(): boolean; error?: unknown }>,
): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    run()
      .then(result => {
        if (result.isFailure()) logger.warn('A run of the background job was refused', { error: String(result.error) });
      })
      .catch(error => logger.error('A run of the background job failed', error))
      .finally(() => {
        running = false;
      });
  }, intervalOf());
  timer.unref();
  app.fastify.addHook('onClose', async () => clearInterval(timer));
}
