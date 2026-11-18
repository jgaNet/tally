import { randomUUID } from 'node:crypto';

import { Clock, Logger, relayOutbox } from '@Architecture/Application';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { prepareStorage } from '@Bootstrap/Fastify/moveFromSqliteFile';

import { localTrackerModule, trackedEventBus } from '@Contexts/Tracker/module.local';
import { operationRoutes } from '@Contexts/Tracker/Presentation/API/REST/Routes';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { authenticate, groupsModuleWith, tokens } from '@Contexts/Groups/module.local';
import { LedgerMemberBalances } from '@Contexts/Groups/Infrastructure/LedgerMemberBalances';
import { SettlementsWaitingPayments } from '@Contexts/Groups/Infrastructure/SettlementsWaitingPayments';
import { accountRoutes, groupRoutes, invitationRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes';
import {
  groupBalanceSums,
  groupBalanceSumsInCommand,
  ledgerModuleWith,
  memberBalanceSumsInCommand,
  recordRecurringExpensesWith,
} from '@Contexts/Ledger/module.local';
import { HttpOfferedRates } from '@Contexts/Ledger/Infrastructure/HttpOfferedRates';
import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/HttpReceiptStore';
import {
  memberDebtsWith,
  memberPaymentsWaitingInCommand,
  settlementsModuleWith,
} from '@Contexts/Settlements/module.local';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/LedgerGroupBalances';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/API/REST/Routes';
import { debtSweepWith, localNotificationsModule } from '@Contexts/Notifications/module.local';
import { SettlementsOutstandingDebts } from '@Contexts/Notifications/Infrastructure/SettlementsOutstandingDebts';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/API/REST/Routes';
import {
  balanceRoutes,
  expenseRoutes,
  rateRoutes,
  recurringRoutes,
  statementRoutes,
  budgetRoutes,
  templateRoutes,
  receiptRoutes,
  auditRoutes,
} from '@Contexts/Ledger/Presentation/API/REST/Routes';

/**
 * The composition root: the transport, the one event bus (which records every operation), the
 * modules and their routes, all over the one PostgreSQL database `DATABASE_URL` names (ADR 22), into which a
 * first start moves what the SQLite file `DATABASE_PATH` names held (ADR 2). Groups
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
  const database = PostgresDatabase.shared();
  // Groups asks Ledger a member's balance when one leaves (ADR 4), and Settlements whether a payment of theirs waits at the
  // provider (ADR 13): the wirings do not import each other, so the composition root gives Groups both ports over their reads.
  const localGroupsModule = groupsModuleWith(
    new LedgerMemberBalances(memberBalanceSumsInCommand),
    new SettlementsWaitingPayments(memberPaymentsWaitingInCommand),
  );
  // Settlements decides on the balances Ledger reads (GroupBalances, ADR 5, ADR 7), outside a transaction for its
  // queries and inside the command's for its command; Ledger in turn reads what Settlements paid. Neither wiring imports
  // the other's module, so the composition root gives Settlements the balances.
  const localSettlementsModule = settlementsModuleWith(
    new LedgerGroupBalances(groupBalanceSums),
    new LedgerGroupBalances(groupBalanceSumsInCommand),
    // The payment provider (ADR 8): its API is PROVIDER_URL; without it, paying through the provider is refused.
    new HttpPaymentProvider(process.env.PROVIDER_URL),
  );
  // The rates service (request 22, ADR 15): its API is RATES_URL; without it, no rate is offered, and an expense in another
  // currency is recorded at the rate its payer states, as request 21 has it.
  // The receipts store (request 26, ADR 19): its API is RECEIPTS_URL; without it, a receipt is refused.
  const localLedgerModule = ledgerModuleWith(
    new HttpOfferedRates(process.env.RATES_URL),
    new HttpReceiptStore(process.env.RECEIPTS_URL),
    clock,
  );
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate,
    unitOfWork: () => new PostgresUnitOfWork(database),
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
    .registerRoutes('/', rateRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', recurringRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', budgetRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', templateRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', receiptRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', auditRoutes, { ledgerModule: localLedgerModule })
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

  // The background job that records the recurring expenses (request 23, ADR 16): every JOBS_INTERVAL_SECONDS, the expense of
  // each day that has come is recorded, once, whatever the number of servers. It is a job of the application, not a request.
  const recordRecurring = recordRecurringExpensesWith(clock);
  app.registerJob({
    name: 'record the recurring expenses',
    every: seconds('JOBS_INTERVAL_SECONDS', 60) * 1000,
    run: () => recordRecurring.run(app.executionContext(randomUUID())),
  });

  // Before anything is served or relayed: the database is prepared, once, and what the SQLite file of an earlier version
  // held is moved into it (ADR 22); then the tokens read their secret, the file's when it was moved.
  // The outbox's table is made by the first unit of work, after the move: it is declared here, so its entries move too.
  database.migrate(PostgresOutbox.STATEMENTS);
  await prepareStorage(database, { file: process.env.DATABASE_PATH, clock, logger });
  await tokens.load();

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is in the
  // database (ADR 22), the entries moved from the SQLite file included, so a fact a crash kept from being published is published by the next server. The
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
