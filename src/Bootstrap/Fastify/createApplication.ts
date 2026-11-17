import { EventEmitter } from 'events';

import { Logger, relayOutbox } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ConsoleLogger } from '@Architecture/Infrastructure/Logging/ConsoleLogger';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';
import { Role } from '@SharedKernel/Domain';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { operationRoutes } from '@Bootstrap/Fastify/operations.routes';
import { localGroupsModule, authenticatedAccountOf } from '@Contexts/Groups/module.local';
import { localLedgerModule } from '@Contexts/Ledger/module.local';
import { accountRoutes } from '@Contexts/Groups/Presentation/accounts.routes';

/**
 * The composition root of the application (docs/adr/0002). It sets up the transport, which gives each
 * request its trace, its caller and its own unit of work over the application's SQLite file, and the
 * bus that carries what the contexts tell each other, relayed from the outbox after each commit. It
 * registers the contexts' modules and their routes under their prefixes, and the background job that
 * relays the outbox every `JOBS_INTERVAL_SECONDS` (60 when unset).
 *
 * Configuration is in the environment: `PORT`, `API_PREFIX` (`v1`), `DATABASE_PATH` (`tally.db`),
 * `JOBS_INTERVAL_SECONDS` (60), `WEB_ORIGINS` (a comma-separated list).
 *
 * A context is added here: its `LiteModule` registered, its routes under its own prefix with `{ module }`:
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
  const app = new FastifyApplication({
    logger,
    apiPrefix,
    port,
    webOrigins,
    unitOfWork: () => new SqliteUnitOfWork(sharedDatabase),
    // The token a request brings proves its account: the Groups context says which, and every other request is anonymous.
    authenticate: async request => {
      const subjectId = authenticatedAccountOf(request.headers.authorization);
      if (subjectId) request.auth = { subjectId, role: Role.USER };
    },
  })
    .setEventBus(new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }))
    .registerModule(localGroupsModule)
    .registerModule(localLedgerModule)
    .registerRoutes('/accounts', accountRoutes, { module: localGroupsModule })
    .registerRoutes('/', operationRoutes, {});

  await app.startModules();

  // What a previous run made durable and did not publish goes out now (ADR 24), and then at every job's run.
  const relay = () =>
    relayOutbox(new SqliteUnitOfWork(sharedDatabase).outbox, app.getEventBus(), app.executionContext('relay'));
  await relay();
  app.every(Number(process.env.JOBS_INTERVAL_SECONDS || 60) * 1000, relay);
  return app;
}
