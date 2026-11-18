import { EventEmitter } from 'events';

import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticeRepository';
import { PostgresNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/PostgresNoticeQueries';
import { PostgresNoticePreferenceRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticePreferenceRepository';

/**
 * One notice per member, even when Tally is stopped at any moment and started again (request 17). A process that dies
 * after the reaction committed and before the outbox entry was marked published hands the same fact out again on the next
 * start, to a bus whose inbox is new: the notices in the database are still one per member.
 */
const AT = new Date('2026-11-17T10:00:00.000Z');
const fact = () =>
  ExpenseRecordedIntegrationEvent.set({
    expenseId: 'pizzas',
    groupId: 'house',
    paidBy: 'bob',
    amount: 1000,
    shares: [
      { memberId: 'bob', amount: 334 },
      { memberId: 'cy', amount: 333 },
      { memberId: 'dee', amount: 333 },
    ],
  });

describe('ExpenseRecordedIntegrationEventHandler (request 17)', () => {
  const databases: PostgresDatabase[] = [];

  afterAll(async () => {
    for (const database of databases) await database.close();
  });

  /** One run of Tally over the database: its own bus, inbox and connections, delivering the fact under the entry id `entry-1`. */
  async function runDelivering(): Promise<boolean | undefined> {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    const notices = new PostgresNoticeRepository(database);
    const preferences = new PostgresNoticePreferenceRepository(database);
    const unitOfWork = new PostgresUnitOfWork(database, new PostgresOutbox(database));
    await database.open();

    const bus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => AT });
    await bus.subscribe(
      ExpenseRecordedIntegrationEvent.name,
      new ExpenseRecordedIntegrationEventHandler(notices, preferences, () => AT),
    );
    const context = new ExecutionContext({
      traceId: 'trace',
      eventBus: bus,
      auth: {},
      unitOfWork,
    });
    return bus.publish(fact(), context, 'entry-1').delivered;
  }

  const noticesOf = async (recipient: string) => {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    const queries = new PostgresNoticeQueries(database);
    await database.open();
    return queries.ofRecipient(recipient);
  };

  it('makes one notice for each member but the payer, and none again when the fact is delivered after a restart', async () => {
    expect(await runDelivering()).toBe(true);
    expect(await runDelivering()).toBe(true);

    expect(await noticesOf('bob')).toEqual([]);
    expect(await noticesOf('cy')).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId: 'house',
        expenseId: 'pizzas',
        amount: 333,
        at: AT.toISOString(),
      },
    ]);
    expect((await noticesOf('dee')).map(notice => notice.amount)).toEqual([333]);
  });
});
