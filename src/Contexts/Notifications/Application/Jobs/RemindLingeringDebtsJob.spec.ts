import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { RemindLingeringDebtsJob } from '@Contexts/Notifications/Application/Jobs/RemindLingeringDebtsJob';
import { OutstandingDebt } from '@Contexts/Notifications/Domain/DebtWatch/DTOs';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IOutstandingDebts';
import { SqliteDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteDebtWatchRepository';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteNoticeRepository';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/SqliteNoticeQueries';

/**
 * The reminders sweep (request 18, ADR 10), on a real file: what each member still owes is the test's, given through the port the
 * sweep asks; the watches and the notices are the application's own stores. A run is one job at one instant, as a server's run is.
 */
class OwedNow implements IOutstandingDebts {
  debts: OutstandingDebt[] = [];
  async owing(): Promise<OutstandingDebt[]> {
    return this.debts;
  }
}

const WEEK = 604_800_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const WEEKLY = WEEK;

describe('RemindLingeringDebtsJob (request 18)', () => {
  let directory: string;
  let file: string;
  let owed: OwedNow;
  let clockAt: number;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-reminders-'));
    file = join(directory, 'tally.db');
    database = new SqliteDatabase(file);
    owed = new OwedNow();
    clockAt = T0;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** One run of the job at `at`, in a context of its own over the file, as the composition root's job is. */
  async function sweep(at: number, { periodMs = WEEKLY } = {}): Promise<void> {
    clockAt = at;
    const job = new RemindLingeringDebtsJob(
      owed,
      new SqliteDebtWatchRepository(database),
      new SqliteNoticeRepository(database),
      () => new Date(clockAt),
    );
    const bus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => new Date(clockAt) });
    const context = new ExecutionContext({
      traceId: `sweep-${at}`,
      eventBus: bus,
      auth: {},
      unitOfWork: new SqliteUnitOfWork(database, new SqliteOutbox(database)),
    });
    await job.run(context, periodMs);
  }

  /** The reminders of the member, as they read them; an expense's notice is another kind and not counted here. */
  const remindersOf = async (memberId: string) =>
    (await new SqliteNoticeQueries(database).ofRecipient(memberId)).filter(notice => notice.kind === 'reminder');

  it('reminds a member who owes more than 2000 once a week while it lasts, and never one who owes 2000 or less', async () => {
    owed.debts = [
      { groupId: 'house', memberId: 'vic', owes: 2500 },
      { groupId: 'house', memberId: 'wes', owes: 2000 },
    ];

    await sweep(T0);
    expect(await remindersOf('vic')).toEqual([]); // noted from this run, not reminded yet

    await sweep(T0 + WEEK);
    const [reminder] = await remindersOf('vic');
    expect(reminder).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      groupId: 'house',
      amount: 2500,
      at: new Date(T0 + WEEK).toISOString(),
    });
    expect(reminder).not.toHaveProperty('expenseId');

    await sweep(T0 + WEEK + HOUR); // the same week: not again
    await sweep(T0 + WEEK + 2 * HOUR); // another server's run at the same moment: not again either
    expect(await remindersOf('vic')).toHaveLength(1);
    expect(await remindersOf('wes')).toEqual([]);

    await sweep(T0 + 2 * WEEK);
    expect(await remindersOf('vic')).toHaveLength(2);
  });

  it('clears a debt paid down to 2000 or less, and makes a debt that comes back wait a week from the run that sees it', async () => {
    owed.debts = [{ groupId: 'house', memberId: 'yui', owes: 2500 }];
    await sweep(T0);
    await sweep(T0 + WEEK);
    expect(await remindersOf('yui')).toHaveLength(1);

    owed.debts = [{ groupId: 'house', memberId: 'yui', owes: 1500 }]; // paid down: the note is cleared
    await sweep(T0 + 2 * WEEK);
    await sweep(T0 + 2 * WEEK + HOUR);
    expect(await remindersOf('yui')).toHaveLength(1);

    owed.debts = [{ groupId: 'house', memberId: 'yui', owes: 3000 }]; // owed again: noted from this run
    await sweep(T0 + 2 * WEEK + 2 * HOUR);
    await sweep(T0 + 3 * WEEK + HOUR); // a week from the run that saw it: not yet
    expect(await remindersOf('yui')).toHaveLength(1);

    await sweep(T0 + 3 * WEEK + 3 * HOUR);
    expect((await remindersOf('yui')).map(notice => notice.amount)).toEqual([3000, 2500]);
  });

  it('clears a note for a member who has left the group, since they no longer owe in it', async () => {
    owed.debts = [{ groupId: 'house', memberId: 'zed', owes: 2500 }];
    await sweep(T0);

    owed.debts = []; // Zed is not a current member, so nothing is owed by Zed
    await sweep(T0 + WEEK);
    owed.debts = [{ groupId: 'house', memberId: 'zed', owes: 2500 }];
    await sweep(T0 + WEEK + HOUR); // noted again from this run, not reminded at once
    expect(await remindersOf('zed')).toEqual([]);
  });

  it('measures the period by the one each run is given', async () => {
    owed.debts = [{ groupId: 'house', memberId: 'ann', owes: 2500 }];
    await sweep(T0, { periodMs: HOUR });
    await sweep(T0 + HOUR, { periodMs: HOUR }); // noted for an hour: reminded
    await sweep(T0 + 2 * HOUR, { periodMs: HOUR }); // a period since that reminder: reminded again
    expect((await remindersOf('ann')).map(notice => notice.at)).toEqual([
      new Date(T0 + 2 * HOUR).toISOString(),
      new Date(T0 + HOUR).toISOString(),
    ]);
  });
});
