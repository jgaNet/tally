import { Logger, relayOutbox } from '@Architecture/Application';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { localTrackerModule, trackedEventBus } from '@Contexts/Tracker/module.local';
import { operationRoutes } from '@Contexts/Tracker/Presentation/API/REST/Routes';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { authenticate, localGroupsModule } from '@Contexts/Groups/module.local';
import { accountRoutes, groupRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes';
import { localLedgerModule } from '@Contexts/Ledger/module.local';
import { localSettlementsModule, webhookSignatures } from '@Contexts/Settlements/module.local';
import { localNotificationsModule } from '@Contexts/Notifications/module.local';
import { noticeRoutes } from '@Contexts/Notifications/Presentation/API/REST/Routes';
import { payoutAccountRoutes, settlementRoutes } from '@Contexts/Settlements/Presentation/API/REST/Routes';
import {
  balanceRoutes,
  budgetRoutes,
  expenseRoutes,
  rateRoutes,
  recurringRoutes,
  statementRoutes,
} from '@Contexts/Ledger/Presentation/API/REST/Routes';

/**
 * The composition root an application starts from (ADR 27): `clean-ddd create` gives it as
 * `src/Bootstrap/Fastify/createApplication.ts`, in place of this repository's, which knows four
 * contexts. It knows one, the Tracker, because a command is answered `202 { operationId }` and
 * the Tracker is what a client follows that operation at, up to its outcome and its result
 * (`GET /v1/tracker/operations/:id`). Nobody signs in here: every caller is anonymous until a
 * context that owns accounts gives the transport its `authenticate`.
 *
 * A new context is added here, as the Tracker is: its module after the Tracker's, its routes
 * under its own prefix.
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
}: { logger?: Logger; apiPrefix?: string; port?: number; webOrigins?: string[] } = {}): Promise<FastifyApplication> {
  // What the application knows is kept in one SQLite file (ADR 2): the state, the outbox and the operations.
  const database = sharedDatabase();
  const outbox = new SqliteOutbox(database);
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate,
    unitOfWork: () => new SqliteUnitOfWork(database, outbox),
  })
    .setEventBus(trackedEventBus)
    .registerModule(localTrackerModule)
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerModule(localSettlementsModule)
    .registerModule(localNotificationsModule)
    // The Groups context's routes write their whole paths, so they are served at the root of the API.
    .registerRoutes('/', accountRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', groupRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', balanceRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', rateRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', statementRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', recurringRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', budgetRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', settlementRoutes, { settlementsModule: localSettlementsModule, webhookSignatures })
    .registerRoutes('/', payoutAccountRoutes, { settlementsModule: localSettlementsModule })
    .registerRoutes('/', noticeRoutes, { notificationsModule: localNotificationsModule })
    .registerRoutes('/operations', operationRoutes, { operationsModule: localTrackerModule })
    .registerRoutes('/tracker/operations', operationRoutes, { operationsModule: localTrackerModule });

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): nothing, with
  // the file's outbox, and the line is where it is relayed. The context is
  // one a request would get, with a unit of work of its own, so that each reaction it delivers
  // runs in a transaction of its own and publishes through the outbox, as after a request.
  await relayOutbox(outbox, app.getEventBus(), app.executionContext('startup'));
  return app;
}
