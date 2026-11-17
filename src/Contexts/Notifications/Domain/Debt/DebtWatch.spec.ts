import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';

const WEEK = 604_800_000;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 24 * 60 * 60 * 1000);

describe('a debt watch', () => {
  it('notes a debt over 2000 at the run that first sees it, and changes nothing for one of 2000 or less', () => {
    const watch = DebtWatch.open({ accountId: 'ann', groupId: 'flat' });
    expect(watch.sweep(2000, day(0), WEEK)).toBe('none');
    expect(watch.notedSince).toBeUndefined();
    expect(watch.sweep(2001, day(1), WEEK)).toBe('noted');
    expect(watch.notedSince).toEqual(day(1));
  });

  it('reminds a member noted for a week, and again only each week while the debt lasts', () => {
    const watch = DebtWatch.open({ accountId: 'ann', groupId: 'flat' });
    watch.sweep(5000, day(0), WEEK);
    expect(watch.sweep(5000, day(6), WEEK)).toBe('none');
    expect(watch.sweep(5000, day(7), WEEK)).toBe('reminded');
    expect(watch.lastRemindedAt).toEqual(day(7));
    expect(watch.sweep(5000, day(13), WEEK)).toBe('none');
    expect(watch.sweep(5000, day(14), WEEK)).toBe('reminded');
  });

  it('clears a noted debt the run sees at 2000 or less, and notes a debt that comes back from the run that sees it', () => {
    const watch = DebtWatch.open({ accountId: 'ann', groupId: 'flat' });
    watch.sweep(3000, day(0), WEEK);
    expect(watch.sweep(2000, day(3), WEEK)).toBe('cleared');
    expect(watch.notedSince).toBeUndefined();
    expect(watch.sweep(3000, day(10), WEEK)).toBe('noted');
    // The last reminder is kept: none was made yet, so a week from the run that sees it is the first.
    expect(watch.sweep(3000, day(16), WEEK)).toBe('none');
    expect(watch.sweep(3000, day(17), WEEK)).toBe('reminded');
  });

  it('keeps the last reminder across a clearance, so a debt that comes back waits a week from its noting', () => {
    const watch = DebtWatch.open({ accountId: 'ann', groupId: 'flat' });
    watch.sweep(3000, day(0), WEEK);
    expect(watch.sweep(3000, day(7), WEEK)).toBe('reminded');
    watch.sweep(0, day(8), WEEK);
    expect(watch.sweep(3000, day(9), WEEK)).toBe('noted');
    expect(watch.sweep(3000, day(9 + 7), WEEK)).toBe('reminded');
  });

  it('answers the same state from a snapshot as it was saved, and refuses a corrupted one', () => {
    const watch = DebtWatch.open({ accountId: 'ann', groupId: 'flat' });
    watch.sweep(3000, day(0), WEEK);
    const restored = DebtWatch.fromSnapshot({ ...watch.toSnapshot(), version: 1 });
    expect(restored.notedSince).toEqual(day(0));
    expect(() => DebtWatch.fromSnapshot({ id: '', version: 1, accountId: 'ann', groupId: 'flat' })).toThrow();
  });
});
