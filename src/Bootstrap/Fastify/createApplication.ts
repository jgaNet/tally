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
import { groupsSchema, groupsWiring } from '@Contexts/Groups/module.local';
import { balanceRoutes } from '@Contexts/Ledger/Presentation/balances.routes';
import { expenseRoutes } from '@Contexts/Ledger/Presentation/expenses.routes';
import { historyRoutes } from '@Contexts/Ledger/Presentation/history.routes';
import { SettledAmountsFromSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsFromSettlements';
import { ledgerBalanceRoster, ledgerSchema, ledgerWiring } from '@Contexts/Ledger/module.local';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/settlements.routes';
import { settlementRoster, settlementsSchema, settlementsWiring } from '@Contexts/Settlements/module.local';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/notices.routes';
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
  // Groups asks a member's balance over Ledger's read model, and Ledger asks Groups' roster: each read model is built over
  // the database alone, so neither wiring needs the other's module to exist (ADR 1 T3, T5).
  const groups = await groupsWiring(
    database,
    new MemberBalancesFromLedger(ledgerBalanceRoster(database, settledAmounts)),
  );
  const ledger = ledgerWiring(database, groups.roster, settledAmounts);
  // The suggested settlements read the members of a group from Groups' roster and its balances from Ledger's read model (ADR 9).
  // Paying through the provider (request 13) is asked of PROVIDER_URL, and its webhooks are checked with PROVIDER_WEBHOOK_SECRET.
  const settlements = settlementsWiring(database, groups.roster, ledgerBalanceRoster(database, settledAmounts), {
    providerUrl,
    webhookSecret: providerWebhookSecret,
  });
  // A notice to each member of an expense's split but its payer, made from ExpenseRecorded (request 17, ADR 13).
  const notifications = notificationsWiring(database);

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

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is the database's.
  await relayOutbox(new SqliteOutbox(database), app.getEventBus(), app.executionContext('startup'));
  return app;
}
