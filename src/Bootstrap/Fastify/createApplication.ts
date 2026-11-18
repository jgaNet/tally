import { EventEmitter } from 'events';

import { Logger, relayOutbox } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { accountRoutes } from '@Contexts/Groups/Presentation/accounts.routes';
import { groupRoutes } from '@Contexts/Groups/Presentation/groups.routes';
import { invitationRoutes } from '@Contexts/Groups/Presentation/invitations.routes';
import { MemberBalancesFromLedger } from '@Contexts/Groups/Infrastructure/MemberBalancesFromLedger';
import { WaitingPaymentsFromSettlements } from '@Contexts/Groups/Infrastructure/WaitingPaymentsFromSettlements';
import { groupRoster, groupsSchema, groupsWiring } from '@Contexts/Groups/module.local';
import { GroupMembersFromGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { GroupCurrencyFromGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyFromGroups';
import { balanceRoutes } from '@Contexts/Ledger/Presentation/balances.routes';
import { expenseRoutes } from '@Contexts/Ledger/Presentation/expenses.routes';
import { historyRoutes } from '@Contexts/Ledger/Presentation/history.routes';
import { SettledAmountsFromSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsFromSettlements';
import { ledgerBalanceRoster, ledgerSchema, ledgerWiring } from '@Contexts/Ledger/module.local';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/settlements.routes';
import {
  outstandingDebtRoster,
  settlementRoster,
  settlementsSchema,
  settlementsWiring,
  waitingPaymentRoster,
} from '@Contexts/Settlements/module.local';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/notices.routes';
import { sweepDebts } from '@Contexts/Notifications/Application/DebtSweep';
import { DebtsFromSettlements } from '@Contexts/Notifications/Infrastructure/DebtsFromSettlements';
import { notificationsSchema, notificationsWiring } from '@Contexts/Notifications/module.local';

/**
 * The composition root (ADR 40, ADR 2): it opens the database the application keeps what it knows in, builds each
 * context's wiring over it, and sets up what every context shares — the transport, which gives each request its trace,
 * its caller and its unit of work, and the bus that carries what the contexts tell each other, relayed from the outbox
 * after each commit. The caller of a request is the one the Groups context proves by its bearer token.
 *
 * A context is added here: its schema given to the database, its wiring built over it, its module registered, its
 * routes mounted, the module in the routes' options. A context has one mount (the contract's binding reads it per context),
 * so its routes write their whole paths under it, and the Groups context mounts at the root (ADR 5):
 *
 *   .registerModule(groups.module)
 *   .registerRoutes('/', accountRoutes, { module: groups.module })
 *   .registerRoutes('/', groupRoutes, { module: groups.module })
 *   .registerRoutes('/', invitationRoutes, { module: groups.module })
 *   .registerRoutes('/', expenseRoutes, { module: ledger })
 *   .registerRoutes('/', balanceRoutes, { module: ledger });
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.sqlite',
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
  providerUrl = process.env.PROVIDER_URL || undefined,
  providerWebhookSecret = process.env.PROVIDER_WEBHOOK_SECRET || undefined,
  jobsIntervalSeconds = Number(process.env.JOBS_INTERVAL_SECONDS || 60),
  reminderPeriodSeconds = Number(process.env.REMINDER_PERIOD_SECONDS || 604800),
}: {
  logger?: Logger;
  apiPrefix?: string;
  port?: number;
  /** The file the application keeps what it knows in (DATABASE_PATH); every server may share it (ADR 2). */
  databasePath?: string;
  webOrigins?: string[];
  /** The base of the payment provider's API, without a trailing slash (PROVIDER_URL); without it, paying through it is refused. */
  providerUrl?: string;
  /** The secret the provider signs its webhooks with, shared with Tally (PROVIDER_WEBHOOK_SECRET). */
  providerWebhookSecret?: string;
  /** How often the background jobs run, in seconds (JOBS_INTERVAL_SECONDS; 60 when it is not set): the debt sweep of request 18. */
  jobsIntervalSeconds?: number;
  /** How long a debt must last before its member is reminded, in seconds (REMINDER_PERIOD_SECONDS; a week when it is not set). */
  reminderPeriodSeconds?: number;
} = {}): Promise<FastifyApplication> {
  const database = SqliteDatabase.open(databasePath, [
    ...groupsSchema,
    ...ledgerSchema,
    ...settlementsSchema,
    ...notificationsSchema,
  ]);
  // What the settlements moved is read by Ledger through a port it owns, over Settlements' read model (ADR 10): every balance counts a
  // settlement once it is recorded. Ledger's balance read model is over the database and that port alone (ADR 1 T3, T5).
  const settledAmounts = new SettledAmountsFromSettlements(settlementRoster(database));
  // Groups' roster is over the database alone, and Ledger asks it who is in a group and which balances passed when members left (request 20,
  // ADR 15). Ledger's balance read model is built over that and what the settlements moved; Groups asks a member's balance over it, and asks
  // Settlements whether a payment of theirs waits at the provider. Each read model is built over the database alone, so no wiring needs
  // another module to exist (ADR 1 T3, T5).
  const groupMembers = new GroupMembersFromGroups(groupRoster(database));
  const groupCurrency = new GroupCurrencyFromGroups(groupRoster(database));
  const balances = ledgerBalanceRoster(database, settledAmounts, groupMembers);
  const groups = await groupsWiring(
    database,
    new MemberBalancesFromLedger(balances),
    new WaitingPaymentsFromSettlements(waitingPaymentRoster(database)),
  );
  const ledger = ledgerWiring(database, groupMembers, groupCurrency, settledAmounts);
  // The suggested settlements read the members of a group from Groups' roster and its balances from Ledger's read model (ADR 9).
  // Paying through the provider (request 13) is asked of PROVIDER_URL, and its webhooks are checked with PROVIDER_WEBHOOK_SECRET.
  const settlements = settlementsWiring(database, groups.roster, balances, {
    providerUrl,
    webhookSecret: providerWebhookSecret,
  });
  // What every member still owes is read from Settlements' read model, which counts the payments waiting at the provider as paid, and
  // Notifications' sweep asks it through its own port (request 18, ADR 14). The sweep runs below, every JOBS_INTERVAL_SECONDS.
  const debts = outstandingDebtRoster(database, groups.roster, balances);
  // A notice to each member of an expense's split but its payer, made from ExpenseRecorded (request 17, ADR 13); a reminder to a member
  // whose debt lasted, made by the sweep (request 18).
  const notifications = notificationsWiring(database, new DebtsFromSettlements(debts), {
    reminderPeriodMs: reminderPeriodSeconds * 1000,
  });

  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate: groups.authenticate,
    unitOfWork: () => new SqliteUnitOfWork(database),
  })
    .setEventBus(new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }))
    .registerModule(groups.module)
    .registerModule(ledger)
    .registerModule(settlements)
    .registerModule(notifications)
    .registerRoutes('/', accountRoutes, { module: groups.module })
    .registerRoutes('/', groupRoutes, { module: groups.module })
    .registerRoutes('/', invitationRoutes, { module: groups.module })
    .registerRoutes('/', expenseRoutes, { module: ledger })
    .registerRoutes('/', balanceRoutes, { module: ledger })
    .registerRoutes('/', historyRoutes, { module: ledger })
    .registerRoutes('/', settlementRoutes, { module: settlements })
    .registerRoutes('/', noticeRoutes, { module: notifications })
    .onStop(() => database.close());

  // The debt sweep (request 18): each run looks at what every member still owes, and notes, reminds or clears them, in its own
  // transaction. A run that loses a race with another server's run is run again on what that run committed (ADR 25).
  app.every(jobsIntervalSeconds * 1000, async () => {
    const result = await notifications.useCase(sweepDebts).run(undefined, app.executionContext('sweep-debts'));
    if (result.isFailure()) app.logger.warn('The debt sweep was refused', { error: result.error });
  });

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is the database's.
  await relayOutbox(new SqliteOutbox(database), app.getEventBus(), app.executionContext('startup'));
  return app;
}
