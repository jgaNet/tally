import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteNoticeRepository';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/SqliteNoticeQueries';

/**
 * One notice per member, even when Tally is stopped at any moment and started again (request 17). A process that dies
 * after the reaction committed and before the outbox entry was marked published hands the same fact out again on the next
 * start, to a bus whose inbox is new: the notices on the file are still one per member.
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
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-notices-'));
    file = join(directory, 'tally.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** One run of Tally over the file: its own bus, inbox and connection, delivering the fact under the entry id `entry-1`. */
  async function runDelivering(): Promise<boolean | undefined> {
    const database = new SqliteDatabase(file);
    const bus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => AT });
    await bus.subscribe(
      ExpenseRecordedIntegrationEvent.name,
      new ExpenseRecordedIntegrationEventHandler(new SqliteNoticeRepository(database), () => AT),
    );
    const context = new ExecutionContext({
      traceId: 'trace',
      eventBus: bus,
      auth: {},
      unitOfWork: new SqliteUnitOfWork(database, new SqliteOutbox(database)),
    });
    return bus.publish(fact(), context, 'entry-1').delivered;
  }

  const noticesOf = (recipient: string) => new SqliteNoticeQueries(new SqliteDatabase(file)).ofRecipient(recipient);

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
