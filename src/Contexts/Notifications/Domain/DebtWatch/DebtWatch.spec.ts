import { describe, expect, it } from '@jest/globals';

import { DEBT_THRESHOLD, DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

const WEEK = 604_800_000;
const at = (ms: number) => new Date(Date.UTC(2026, 10, 17) + ms);

describe('DebtWatch', () => {
  it('notes a debt above the threshold from the run that sees it, and reminds nobody that same run', () => {
    const watch = DebtWatch.create({ groupId: 'g', memberId: 'bob' });

    const sighting = watch.sight(DEBT_THRESHOLD + 1, at(0), WEEK);

    expect(sighting).toEqual({ reminderDue: false, changed: true });
    expect(watch.toSnapshot()).toMatchObject({ notedAt: at(0).toISOString() });
  });

  it('is due a reminder once the debt has lasted a period, and not again within the period after one', () => {
    const watch = DebtWatch.create({ groupId: 'g', memberId: 'bob' });
    watch.sight(2500, at(0), WEEK);

    expect(watch.sight(2500, at(WEEK - 1), WEEK).reminderDue).toBe(false);
    expect(watch.sight(2500, at(WEEK), WEEK).reminderDue).toBe(true);
    watch.remind(2500, at(WEEK));
    expect(watch.sight(2500, at(WEEK + 1), WEEK).reminderDue).toBe(false);
    expect(watch.sight(2500, at(2 * WEEK), WEEK).reminderDue).toBe(true);
  });

  it('does not count 2000 as owing: at the threshold the watch is cleared, and a debt that comes back is noted from its run', () => {
    const watch = DebtWatch.create({ groupId: 'g', memberId: 'bob' });
    watch.sight(2500, at(0), WEEK);

    const cleared = watch.sight(DEBT_THRESHOLD, at(10), WEEK);
    expect(cleared).toEqual({ reminderDue: false, changed: true });
    expect(watch.toSnapshot().notedAt).toBeUndefined();

    watch.sight(2500, at(20), WEEK);
    expect(watch.toSnapshot().notedAt).toBe(at(20).toISOString());
  });

  it('keeps the last reminder through a clearing, so a debt that comes back waits for a period from the run that sees it', () => {
    const watch = DebtWatch.create({ groupId: 'g', memberId: 'bob' });
    watch.sight(2500, at(0), WEEK);
    watch.remind(2500, at(WEEK));
    watch.sight(100, at(WEEK + 5), WEEK);
    watch.sight(2500, at(WEEK + 10), WEEK);

    expect(watch.sight(2500, at(2 * WEEK + 9), WEEK).reminderDue).toBe(false);
    expect(watch.sight(2500, at(2 * WEEK + 10), WEEK).reminderDue).toBe(true);
  });

  it('is not changed by a sighting that has nothing to note or clear', () => {
    const watch = DebtWatch.create({ groupId: 'g', memberId: 'bob' });

    expect(watch.sight(100, at(0), WEEK)).toEqual({ reminderDue: false, changed: false });
    expect(watch.changed).toBe(false);
  });
});
