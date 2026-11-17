import { randomUUID } from 'node:crypto';

import { Clock, Logger, relayOutbox } from '@Architecture/Application';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { localTrackerModule, trackedEventBus } from '@Contexts/Tracker/module.local';
import { operationRoutes } from '@Contexts/Tracker/Presentation/API/REST/Routes';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { authenticate, groupsModuleWith } from '@Contexts/Groups/module.local';
import { LedgerMemberBalances } from '@Contexts/Groups/Infrastructure/LedgerMemberBalances';
import { accountRoutes, groupRoutes, invitationRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes';
import {
  groupBalanceSums,
  groupBalanceSumsInCommand,
  localLedgerModule,
  memberBalanceSumsInCommand,
} from '@Contexts/Ledger/module.local';
import { memberDebtsWith, settlementsModuleWith } from '@Contexts/Settlements/module.local';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/LedgerGroupBalances';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/API/REST/Routes';
import { debtSweepWith, localNotificationsModule } from '@Contexts/Notifications/module.local';
import { SettlementsOutstandingDebts } from '@Contexts/Notifications/Infrastructure/SettlementsOutstandingDebts';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/API/REST/Routes';
import { balanceRoutes, expenseRoutes, statementRoutes } from '@Contexts/Ledger/Presentation/API/REST/Routes';

/**
 * The composition root: the transport, the one event bus (which records every operation), the
 * modules and their routes, all over the one SQLite file `DATABASE_PATH` names (ADR 2). Groups
 * owns accounts and so gives the transport its `authenticate`; the Tracker is what a client
 * follows a command's operation at (`GET /v1/operations/:id`).
 *
 * A new context is added here, as the others are: its module, its routes under its own prefix.
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
  clock = systemClock,
}: {
  logger?: Logger;
  apiPrefix?: string;
  port?: number;
  webOrigins?: string[];
  /** The application's now, given to the background job (ADR 42); a test passes a clock it moves. */
  clock?: Clock;
} = {}): Promise<FastifyApplication> {
  const database = SqliteDatabase.shared();
  // Groups asks Ledger a member's balance when one leaves (ADR 4): the two wirings do not import each other, so the
  // composition root gives Groups the port over Ledger's read.
  const localGroupsModule = groupsModuleWith(new LedgerMemberBalances(memberBalanceSumsInCommand));
  // Settlements decides on the balances Ledger reads (GroupBalances, ADR 5, ADR 7), outside a transaction for its
  // queries and inside the command's for its command; Ledger in turn reads what Settlements paid. Neither wiring imports
  // the other's module, so the composition root gives Settlements the balances.
  const localSettlementsModule = settlementsModuleWith(
    new LedgerGroupBalances(groupBalanceSums),
    new LedgerGroupBalances(groupBalanceSumsInCommand),
    // The payment provider (ADR 8): its API is PROVIDER_URL; without it, paying through the provider is refused.
    new HttpPaymentProvider(process.env.PROVIDER_URL),
  );
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate,
    unitOfWork: () => new SqliteUnitOfWork(database),
  })
    .setEventBus(trackedEventBus)
    .registerModule(localTrackerModule)
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerModule(localSettlementsModule)
    .registerModule(localNotificationsModule)
    .registerRoutes('/', accountRoutes, { accountsModule: localGroupsModule })
    .registerRoutes('/', groupRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', invitationRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', balanceRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', statementRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', settlementRoutes, {
      settlementsModule: localSettlementsModule,
      // The secret the provider signs its webhooks with (ADR 8), read here, at the transport that checks them.
      providerWebhookSecret: process.env.PROVIDER_WEBHOOK_SECRET ?? '',
    })
    .registerRoutes('/', noticeRoutes, { notificationsModule: localNotificationsModule })
    .registerRoutes('/operations', operationRoutes, { operationsModule: localTrackerModule });

  // The background job that notes the lasting debts and reminds them (request 18, ADR 12): every JOBS_INTERVAL_SECONDS,
  // it reads what each member still owes from Settlements (its balances from Ledger, as Settlements reads them), and the
  // reminder period is REMINDER_PERIOD_SECONDS. It is a job of the application, not a request: nothing reads it.
  const sweep = debtSweepWith(
    new SettlementsOutstandingDebts(memberDebtsWith(new LedgerGroupBalances(groupBalanceSums))),
    clock,
    seconds('REMINDER_PERIOD_SECONDS', 604800) * 1000,
  );
  app.registerJob({
    name: 'sweep the debts',
    every: seconds('JOBS_INTERVAL_SECONDS', 60) * 1000,
    run: () => sweep.run(app.executionContext(randomUUID())),
  });

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is in the
  // database file, so a fact a crash kept from being published is published by the next server. The
  // context is one a request would get, with a unit of work of its own, so that each reaction it
  // delivers runs in a transaction of its own and publishes through the outbox, as after a request.
  const startup = app.executionContext('startup');
  if (startup.unitOfWork) await relayOutbox(startup.unitOfWork.outbox, app.getEventBus(), startup);
  return app;
}

/** A number of seconds from the environment, when it is set to a positive number; the default otherwise. */
function seconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] && value > 0 ? value : fallback;
}
