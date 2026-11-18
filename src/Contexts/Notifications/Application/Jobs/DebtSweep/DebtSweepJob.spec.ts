import { expect, jest } from '@jest/globals';

import { EventBus } from '@Architecture/Application/EventBus';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { ConcurrencyConflictException, Id } from '@Architecture/Domain';
import { randomBytes } from 'node:crypto';

import { PostgresDatabase, closeDatabases } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Application/Ports/IOutstandingDebts';
import { DebtSweepJob } from '@Contexts/Notifications/Application/Jobs/DebtSweep/DebtSweepJob';
import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { PostgresDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/PostgresDebtWatchRepository';

const WEEK_SECONDS = 604_800;
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * DAY);

/** The debts the sweep reads at each run: the test sets them before it runs the sweep. */
class Debts implements IOutstandingDebts {
  owing: OutstandingDebt[] = [];
  async outstanding(): Promise<OutstandingDebt[]> {
    return this.owing;
  }
}

/** A sweep over an database of its own, with a unit of work of its own and a bus that records what is published from the outbox. */
function setUp() {
  const database = new PostgresDatabase(process.env.DATABASE_URL as string, `sweep_${randomBytes(6).toString('hex')}`);
  const publish = jest.fn((_event: unknown, _context: unknown, _messageId?: unknown) => undefined);
  const eventBus = { connect: jest.fn(), publish, subscribe: jest.fn() } as unknown as EventBus;
  const context = new ExecutionContext({
    traceId: 'sweep',
    eventBus,
    auth: {},
    unitOfWork: new PostgresUnitOfWork(database, new PostgresOutbox(database)),
  });
  const debts = new Debts();
  const watches = new PostgresDebtWatchRepository(database);
  const sweep = (at: Date) => new DebtSweepJob(debts, watches, () => at, WEEK_SECONDS).run(context);
  /** The names of the domain events published since the last call. */
  const published = () => {
    const names = publish.mock.calls.map(([event]) => (event as { name: string }).name);
    publish.mockClear();
    return names;
  };
  return { database, debts, watches, sweep, published };
}

describe('DebtSweepJob (ADR 10)', () => {
  afterAll(closeDatabases);

  it('notes a debt above 2000 from the sweep that first sees it, and reminds it a week later, and again each week it lasts', async () => {
    const { debts, sweep, published } = setUp();
    debts.owing = [{ groupId: 'flat', memberId: 'cy', owed: 2500 }];

    await sweep(day(0));
    expect(published()).toEqual(['DebtNotedEvent']);

    await sweep(new Date(day(7).getTime() - 3_600_000));
    expect(published()).toEqual([]);

    await sweep(day(7));
    expect(published()).toEqual(['ReminderIssuedEvent']);

    await sweep(day(7.5));
    expect(published()).toEqual([]);

    await sweep(day(14));
    expect(published()).toEqual(['ReminderIssuedEvent']);
  });

  it('notes nothing for a debt of 2000 or less, and clears a noted debt the sweep sees gone', async () => {
    const { debts, sweep, published } = setUp();
    debts.owing = [{ groupId: 'flat', memberId: 'cy', owed: 2000 }];
    await sweep(day(0));
    expect(published()).toEqual([]);

    debts.owing = [{ groupId: 'flat', memberId: 'cy', owed: 2001 }];
    await sweep(day(1));
    expect(published()).toEqual(['DebtNotedEvent']);

    debts.owing = [];
    await sweep(day(2));
    expect(published()).toEqual(['DebtClearedEvent']);
  });

  it('waits a period from the sweep that sees a debt come back, after its last reminder', async () => {
    const { debts, sweep, published } = setUp();
    debts.owing = [{ groupId: 'flat', memberId: 'cy', owed: 2500 }];
    await sweep(day(0));
    await sweep(day(7));
    expect(published()).toEqual(['DebtNotedEvent', 'ReminderIssuedEvent']);

    debts.owing = [];
    await sweep(day(8));
    expect(published()).toEqual(['DebtClearedEvent']);

    debts.owing = [{ groupId: 'flat', memberId: 'cy', owed: 2500 }];
    await sweep(day(9));
    expect(published()).toEqual(['DebtNotedEvent']);

    await sweep(day(15));
    expect(published()).toEqual([]);

    await sweep(day(16));
    expect(published()).toEqual(['ReminderIssuedEvent']);
  });

  it('keeps each member of each group apart', async () => {
    const { debts, sweep, published } = setUp();
    debts.owing = [
      { groupId: 'flat', memberId: 'cy', owed: 2500 },
      { groupId: 'flat', memberId: 'dee', owed: 100 },
      { groupId: 'trip', memberId: 'cy', owed: 9000 },
    ];
    await sweep(day(0));
    expect(published()).toEqual(['DebtNotedEvent', 'DebtNotedEvent']);
  });
});

describe('PostgresDebtWatchRepository (ADR 10)', () => {
  it('refuses a watch saved at a version another save has moved past, so the sweep reads it again', async () => {
    const { database, watches } = setUp();
    await database.prepare();
    const opened = DebtWatch.open({ groupId: new Id('flat'), memberId: new Id('cy') });
    opened.see({ owed: 2500, now: day(0) });
    expect((await watches.save(opened)).isFailure()).toBe(false);

    const first = (await watches.find('flat', 'cy')) as DebtWatch;
    const second = (await watches.find('flat', 'cy')) as DebtWatch;
    first.remindIfDue({ owed: 2500, now: day(7), period: WEEK_SECONDS * 1000 });
    expect((await watches.save(first)).isFailure()).toBe(false);

    second.see({ owed: 0, now: day(8) });
    const refused = await watches.save(second);
    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ConcurrencyConflictException);
  });
});
