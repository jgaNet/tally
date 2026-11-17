import { Logger, relayOutbox } from '@Architecture/Application';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { localTrackerModule, trackedEventBus } from '@Contexts/Tracker/module.local';
import { operationRoutes } from '@Contexts/Tracker/Presentation/API/REST/Routes';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { authenticateAccount, localGroupsModule } from '@Contexts/Groups/module.local';
import { accountRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes/account.routes';
import { groupRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes/group.routes';
import { invitationRoutes } from '@Contexts/Groups/Presentation/API/REST/Routes/invitation.routes';
import { expenseRoutes } from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes';
import { balanceRoutes } from '@Contexts/Ledger/Presentation/API/REST/Routes/balance.routes';
import { statementRoutes } from '@Contexts/Ledger/Presentation/API/REST/Routes/statement.routes';
import { localLedgerModule } from '@Contexts/Ledger/module.local';
import { localSettlementsModule } from '@Contexts/Settlements/module.local';
import { settlementRoutes } from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes';
import { localNotificationsModule } from '@Contexts/Notifications/module.local';

/**
 * The composition root (ADR 27): the application's state is in one SQLite file (DATABASE_PATH), and every request
 * and job works on it through a unit of work over that file, so a command's writes and its outbox entries commit
 * together (ADR 24, ADR 2). Callers are signed in with the bearer token the Groups context issues; the Tracker
 * records every operation, so a client answered `202 { operationId }` follows it at `GET /v1/operations/:id`.
 *
 * A context is added here: its module after the Tracker's, its routes mounted once at the root (each route file names its full paths).
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
  jobsIntervalSeconds = Number(process.env.JOBS_INTERVAL_SECONDS || 60),
}: {
  logger?: Logger;
  apiPrefix?: string;
  port?: number;
  webOrigins?: string[];
  jobsIntervalSeconds?: number;
} = {}): Promise<FastifyApplication> {
  const database = applicationDatabase();
  const outbox = new SqliteOutbox(database);

  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    authenticate: authenticateAccount,
    unitOfWork: () => new SqliteUnitOfWork(database, outbox),
  })
    .setEventBus(trackedEventBus)
    .registerModule(localTrackerModule)
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerModule(localSettlementsModule)
    .registerModule(localNotificationsModule)
    .registerRoutes('/operations', operationRoutes, { operationsModule: localTrackerModule })
    .registerRoutes('/', accountRoutes, { module: localGroupsModule })
    .registerRoutes('/', groupRoutes, { module: localGroupsModule })
    .registerRoutes('/', invitationRoutes, { module: localGroupsModule })
    .registerRoutes('/', expenseRoutes, { module: localLedgerModule })
    .registerRoutes('/', balanceRoutes, { module: localLedgerModule })
    .registerRoutes('/', statementRoutes, { module: localLedgerModule })
    .registerRoutes('/', settlementRoutes, {
      module: localSettlementsModule,
      providerWebhookSecret: process.env.PROVIDER_WEBHOOK_SECRET ?? '',
    });

  await app.startModules();

  // What a previous run made durable and did not publish goes out now (ADR 24), then again on every run of the job.
  await relayOutbox(outbox, app.getEventBus(), app.executionContext('startup'));
  app.schedule(jobsIntervalSeconds * 1000, () => relayOutbox(outbox, app.getEventBus(), app.executionContext('job')));

  return app;
}
