import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { PostgresDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresDebtWatchRepository';

/**
 * Two servers on one database (request 18, ADR 10): a debt watch read by two runs at the same version is saved by the first only;
 * the second is refused, reads again, and finds the reminder the first made. Held on a real database, as the settlement book is.
 */
describe('PostgresDebtWatchRepository', () => {
  const AT = new Date('2026-11-17T10:00:00.000Z');
  const WEEK = 604_800_000;
  const databases: PostgresDatabase[] = [];

  /** A server on the application's database: its repository is built first (it declares its table), then the database is opened. */
  async function startServer(): Promise<PostgresDebtWatchRepository> {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    const repository = new PostgresDebtWatchRepository(database);
    await database.open();
    return repository;
  }

  afterAll(async () => {
    for (const database of databases) await database.close();
  });

  it('keeps what the first run decided, and refuses a second run that read the watch before it', async () => {
    const first = await startServer();
    const opened = DebtWatch.open({ groupId: 'house', memberId: 'cy' });
    if (opened.isFailure()) throw opened.error;
    const noted = opened.data;
    noted.observe({ owes: 2500, at: AT, periodMs: WEEK });
    expect((await first.save(noted)).isSuccess()).toBe(true);

    const watchOfFirst = (await first.findBy('house', 'cy'))!;
    const watchOfSecond = (await (await startServer()).findBy('house', 'cy'))!;
    expect(watchOfFirst.observe({ owes: 2500, at: new Date(AT.getTime() + WEEK), periodMs: WEEK }).reminded).toBe(true);
    expect((await first.save(watchOfFirst)).isSuccess()).toBe(true);

    const reminded = watchOfSecond.observe({ owes: 2500, at: new Date(AT.getTime() + WEEK), periodMs: WEEK });
    expect(reminded.reminded).toBe(true);
    const refused = await (await startServer()).save(watchOfSecond);
    expect(refused.isFailure() && refused.error instanceof ConcurrencyConflictException).toBe(true);

    const stored = (await first.findBy('house', 'cy'))!.toSnapshot();
    expect(stored.lastReminded).toEqual(new Date(AT.getTime() + WEEK));
    expect(stored.version).toBe(2);
  });

  it('lists the members whose debt is noted, and no other', async () => {
    const repository = await startServer();
    const noted = DebtWatch.open({ groupId: 'flat', memberId: 'cy' });
    const cleared = DebtWatch.open({ groupId: 'flat', memberId: 'dee' });
    if (noted.isFailure() || cleared.isFailure()) throw new Error('a watch is for a member of a group');
    noted.data.observe({ owes: 2500, at: AT, periodMs: WEEK });
    cleared.data.observe({ owes: 100, at: AT, periodMs: WEEK });
    await repository.save(noted.data);
    await repository.save(cleared.data);

    // The database holds the first test's watches too: only this test's group is read here.
    const notedInFlat = (await repository.notedMembers()).filter(watch => watch.groupId === 'flat');
    expect(notedInFlat).toEqual([{ groupId: 'flat', memberId: 'cy' }]);
  });
});
