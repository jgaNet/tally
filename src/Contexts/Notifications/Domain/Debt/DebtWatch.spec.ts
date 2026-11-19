import { Id } from '@Architecture/Domain';
import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { DEBT_THRESHOLD } from '@Contexts/Notifications/Domain/Debt/Threshold';

const groupId = new Id('group');
const memberId = new Id('member');
const WEEK = 604_800_000;
const day = (n: number) => new Date(Date.UTC(2030, 0, 1) + n * 86_400_000);

function noted(at: Date): DebtWatch {
  const created = DebtWatch.create({ groupId, memberId, owed: DEBT_THRESHOLD + 1, at });
  if (created.isFailure()) throw new Error('refused');
  created.data.pullDomainEvents();
  return created.data;
}

describe('DebtWatch: a debt over 2000 is noted from the run that sees it, reminded once a period while it lasts, and cleared at 2000 or less (request 18)', () => {
  it('is only kept for a debt over the threshold, and records DebtNoted when it is', () => {
    expect(DebtWatch.create({ groupId, memberId, owed: DEBT_THRESHOLD, at: day(0) }).isFailure()).toBe(true);
    const created = DebtWatch.create({ groupId, memberId, owed: 2500, at: day(0) });
    if (created.isFailure()) throw new Error('refused');
    expect(created.data.version).toBe(0);
    expect(created.data.pullDomainEvents().map(event => event.name)).toEqual(['DebtNotedEvent']);
  });

  it('is not reminded at the run that notes it, nor before a period has passed', () => {
    const watch = noted(day(0));
    expect(watch.observe({ owed: 2500, at: day(0), period: WEEK, remind: true })).toBe('unchanged');
    expect(watch.observe({ owed: 2500, at: new Date(day(0).getTime() + WEEK - 1), period: WEEK, remind: true })).toBe(
      'unchanged',
    );
    expect(watch.pullDomainEvents()).toEqual([]);
  });

  it('is reminded at the first run a week after it was noted, and not again within that week', () => {
    const watch = noted(day(0));
    expect(watch.observe({ owed: 2500, at: day(7), period: WEEK, remind: true })).toBe('reminded');
    expect(watch.pullDomainEvents().map(event => event.name)).toEqual(['ReminderIssuedEvent']);
    expect(watch.observe({ owed: 2500, at: new Date(day(7).getTime() + 1), period: WEEK, remind: true })).toBe(
      'unchanged',
    );
  });

  it('is reminded again each period while the debt lasts', () => {
    const watch = noted(day(0));
    expect(watch.observe({ owed: 2500, at: day(7), period: WEEK, remind: true })).toBe('reminded');
    expect(watch.observe({ owed: 2500, at: day(14), period: WEEK, remind: true })).toBe('reminded');
    expect(watch.observe({ owed: 2500, at: day(15), period: WEEK, remind: true })).toBe('unchanged');
  });

  it('is cleared at 2000 or less, keeping its last reminder, and a debt that comes back waits from the run that sees it', () => {
    const watch = noted(day(0));
    expect(watch.observe({ owed: 2500, at: day(7), period: WEEK, remind: true })).toBe('reminded');
    watch.pullDomainEvents();

    expect(watch.observe({ owed: DEBT_THRESHOLD, at: day(8), period: WEEK, remind: true })).toBe('changed');
    expect(watch.pullDomainEvents().map(event => event.name)).toEqual(['DebtClearedEvent']);
    expect(watch.observe({ owed: 0, at: day(9), period: WEEK, remind: true })).toBe('unchanged');

    // It comes back at day 10: noted from then, so it is reminded a week after day 10, not at once.
    expect(watch.observe({ owed: 2500, at: day(10), period: WEEK, remind: true })).toBe('changed');
    expect(watch.observe({ owed: 2500, at: day(16), period: WEEK, remind: true })).toBe('unchanged');
    expect(watch.observe({ owed: 2500, at: day(17), period: WEEK, remind: true })).toBe('reminded');
  });

  it('round-trips through its snapshot, which records nothing', () => {
    const watch = noted(day(0));
    watch.observe({ owed: 2500, at: day(7), period: WEEK, remind: true });
    const restored = DebtWatch.fromSnapshot(watch.toSnapshot(), 3);
    expect(restored.version).toBe(3);
    expect(restored.pullDomainEvents()).toEqual([]);
    expect(restored.observe({ owed: 2500, at: day(14), period: WEEK, remind: true })).toBe('reminded');
  });

  it('keeps the noting and makes no reminder while reminders are off, and reminds at the first run that finds them on (request 36)', () => {
    const watch = noted(day(0));
    expect(watch.observe({ owed: 2500, at: day(7), period: WEEK, remind: false })).toBe('unchanged');
    expect(watch.observe({ owed: 2500, at: day(8), period: WEEK, remind: false })).toBe('unchanged');
    expect(watch.pullDomainEvents()).toEqual([]);
    // Still due, and not counted as made: the first run that finds reminders on reminds.
    expect(watch.observe({ owed: 2500, at: day(9), period: WEEK, remind: true })).toBe('reminded');
  });

  it('refuses a stored watch with a time it cannot read', () => {
    expect(() =>
      DebtWatch.fromSnapshot({ id: 'w', groupId: 'g', memberId: 'm', notedSince: 'nonsense', lastReminded: null }, 1),
    ).toThrow();
  });
});
