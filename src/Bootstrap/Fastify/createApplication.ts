import { Logger, relayOutbox } from '@Architecture/Application';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { localTrackerModule, trackedEventBus } from '@Contexts/Tracker/module.local';
import { operationRoutes } from '@Contexts/Tracker/Presentation/API/REST/Routes';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { authenticate, localGroupsModule } from '@Contexts/Groups/module.local';
import { accountRoutes, groupRoutes, invitationRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes';
import { localLedgerModule } from '@Contexts/Ledger/module.local';
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
}: { logger?: Logger; apiPrefix?: string; port?: number; webOrigins?: string[] } = {}): Promise<FastifyApplication> {
  const database = SqliteDatabase.shared();
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
    .registerRoutes('/', accountRoutes, { accountsModule: localGroupsModule })
    .registerRoutes('/', groupRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', invitationRoutes, { groupsModule: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', balanceRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/', statementRoutes, { ledgerModule: localLedgerModule })
    .registerRoutes('/operations', operationRoutes, { operationsModule: localTrackerModule });

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is in the
  // database file, so a fact a crash kept from being published is published by the next server. The
  // context is one a request would get, with a unit of work of its own, so that each reaction it
  // delivers runs in a transaction of its own and publishes through the outbox, as after a request.
  const startup = app.executionContext('startup');
  if (startup.unitOfWork) await relayOutbox(startup.unitOfWork.outbox, app.getEventBus(), startup);
  return app;
}
