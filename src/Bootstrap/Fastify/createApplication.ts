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
import { groupsSchema, groupsWiring } from '@Contexts/Groups/module.local';
import { localLedgerModule } from '@Contexts/Ledger/module.local';

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
 *   .registerRoutes('/', groupRoutes, { module: groups.module });
 */
export async function createApplication({
  logger = new ConsoleLogger({ debug: false }),
  apiPrefix = process.env.API_PREFIX || 'v1',
  port = Number(process.env.PORT || 10000),
  databasePath = process.env.DATABASE_PATH || 'tally.sqlite',
  webOrigins = String(process.env.WEB_ORIGINS || '')
    .split(',')
    .filter(Boolean),
}: {
  logger?: Logger;
  apiPrefix?: string;
  port?: number;
  /** The file the application keeps what it knows in (DATABASE_PATH); every server may share it (ADR 2). */
  databasePath?: string;
  webOrigins?: string[];
} = {}): Promise<FastifyApplication> {
  const database = SqliteDatabase.open(databasePath, groupsSchema);
  const groups = await groupsWiring(database);

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
    .registerModule(localLedgerModule)
    .registerRoutes('/', accountRoutes, { module: groups.module })
    .registerRoutes('/', groupRoutes, { module: groups.module })
    .onStop(() => database.close());

  await app.startModules();
  // What a previous run made durable and did not publish goes out now (ADR 24): the outbox is the database's.
  await relayOutbox(new SqliteOutbox(database), app.getEventBus(), app.executionContext('startup'));
  return app;
}
