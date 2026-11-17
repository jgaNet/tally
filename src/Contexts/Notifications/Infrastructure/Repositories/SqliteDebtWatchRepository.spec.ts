import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { SqliteDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteDebtWatchRepository';

/**
 * Two servers on one file (request 18, ADR 10): a debt watch read by two runs at the same version is saved by the first only;
 * the second is refused, reads again, and finds the reminder the first made. Held on a real file, as the settlement book is.
 */
describe('SqliteDebtWatchRepository', () => {
  const AT = new Date('2026-11-17T10:00:00.000Z');
  const WEEK = 604_800_000;
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-debt-watches-'));
    file = join(directory, 'tally.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps what the first run decided, and refuses a second run that read the watch before it', async () => {
    const first = new SqliteDebtWatchRepository(new SqliteDatabase(file));
    const opened = DebtWatch.open({ groupId: 'house', memberId: 'cy' });
    if (opened.isFailure()) throw opened.error;
    const noted = opened.data;
    noted.observe({ owes: 2500, at: AT, periodMs: WEEK });
    expect((await first.save(noted)).isSuccess()).toBe(true);

    const watchOfFirst = (await first.findBy('house', 'cy'))!;
    const watchOfSecond = (await new SqliteDebtWatchRepository(new SqliteDatabase(file)).findBy('house', 'cy'))!;
    expect(watchOfFirst.observe({ owes: 2500, at: new Date(AT.getTime() + WEEK), periodMs: WEEK }).reminded).toBe(true);
    expect((await first.save(watchOfFirst)).isSuccess()).toBe(true);

    const reminded = watchOfSecond.observe({ owes: 2500, at: new Date(AT.getTime() + WEEK), periodMs: WEEK });
    expect(reminded.reminded).toBe(true);
    const refused = await new SqliteDebtWatchRepository(new SqliteDatabase(file)).save(watchOfSecond);
    expect(refused.isFailure() && refused.error instanceof ConcurrencyConflictException).toBe(true);

    const stored = (await first.findBy('house', 'cy'))!.toSnapshot();
    expect(stored.lastReminded).toEqual(new Date(AT.getTime() + WEEK));
    expect(stored.version).toBe(2);
  });

  it('lists the members whose debt is noted, and no other', async () => {
    const repository = new SqliteDebtWatchRepository(new SqliteDatabase(file));
    const noted = DebtWatch.open({ groupId: 'house', memberId: 'cy' });
    const cleared = DebtWatch.open({ groupId: 'house', memberId: 'dee' });
    if (noted.isFailure() || cleared.isFailure()) throw new Error('a watch is for a member of a group');
    noted.data.observe({ owes: 2500, at: AT, periodMs: WEEK });
    cleared.data.observe({ owes: 100, at: AT, periodMs: WEEK });
    await repository.save(noted.data);
    await repository.save(cleared.data);

    expect(await repository.notedMembers()).toEqual([{ groupId: 'house', memberId: 'cy' }]);
  });
});
