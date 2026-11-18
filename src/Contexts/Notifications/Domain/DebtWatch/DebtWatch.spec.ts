import { DebtWatch, lingeringDebtOver } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

const WEEK = 604_800_000;
const DAY = 86_400_000;
const T0 = new Date('2026-11-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function watch(): DebtWatch {
  const opened = DebtWatch.open({ groupId: 'house', memberId: 'cy' });
  if (opened.isFailure()) throw opened.error;
  return opened.data;
}

describe('DebtWatch (request 18)', () => {
  it('is a debt over 2000 in cents, and a debt of 2000 or less is not one', () => {
    expect(lingeringDebtOver('EUR')).toBe(2000);
    expect(lingeringDebtOver('JPY')).toBe(20);
    expect(lingeringDebtOver('KWD')).toBe(20000);
    const w = watch();
    expect(w.observe({ over: 2000, owes: 2000, at: at(0), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: false,
      reminded: false,
    });
    expect(w.toSnapshot().notedSince).toBeNull();
  });

  it('notes a debt from the run that first sees it, and reminds it only once it has lasted a period', () => {
    const w = watch();
    expect(w.observe({ over: 2000, owes: 2001, at: at(0), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: true,
      reminded: false,
    });
    expect(w.observe({ over: 2000, owes: 2001, at: at(DAY), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: false,
      reminded: false,
    });
    expect(w.toSnapshot().notedSince).toEqual(at(0));

    expect(w.observe({ over: 2000, owes: 2001, at: at(WEEK), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: true,
      reminded: true,
    });
    expect(w.toSnapshot().lastReminded).toEqual(at(WEEK));
  });

  it('reminds again each period while the debt lasts, and not twice within one', () => {
    const w = watch();
    w.observe({ over: 2000, owes: 2500, at: at(0), periodMs: WEEK, mayRemind: true });
    w.observe({ over: 2000, owes: 2500, at: at(WEEK), periodMs: WEEK, mayRemind: true });

    expect(w.observe({ over: 2000, owes: 2500, at: at(WEEK + DAY), periodMs: WEEK, mayRemind: true }).reminded).toBe(
      false,
    );
    expect(w.observe({ over: 2000, owes: 2500, at: at(2 * WEEK), periodMs: WEEK, mayRemind: true }).reminded).toBe(
      true,
    );
  });

  it('clears the note at a run that sees 2000 or less, keeps the last reminder, and makes a returning debt wait a period from the run that sees it', () => {
    const w = watch();
    w.observe({ over: 2000, owes: 2500, at: at(0), periodMs: WEEK, mayRemind: true });
    w.observe({ over: 2000, owes: 2500, at: at(WEEK), periodMs: WEEK, mayRemind: true });

    expect(w.observe({ over: 2000, owes: 1000, at: at(WEEK + DAY), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: true,
      reminded: false,
    });
    expect(w.toSnapshot()).toEqual(expect.objectContaining({ notedSince: null, lastReminded: at(WEEK) }));

    // The debt comes back at 2 weeks: noted from that run, and not reminded until a week after it.
    expect(w.observe({ over: 2000, owes: 3000, at: at(2 * WEEK), periodMs: WEEK, mayRemind: true })).toEqual({
      changed: true,
      reminded: false,
    });
    expect(
      w.observe({ over: 2000, owes: 3000, at: at(3 * WEEK - DAY), periodMs: WEEK, mayRemind: true }).reminded,
    ).toBe(false);
    expect(w.observe({ over: 2000, owes: 3000, at: at(3 * WEEK), periodMs: WEEK, mayRemind: true }).reminded).toBe(
      true,
    );
  });

  it('records the facts of each change, and none for a run that changes nothing', () => {
    const w = watch();
    w.observe({ over: 2000, owes: 2500, at: at(0), periodMs: WEEK, mayRemind: true });
    w.observe({ over: 2000, owes: 2500, at: at(DAY), periodMs: WEEK, mayRemind: true });
    w.observe({ over: 2000, owes: 2500, at: at(WEEK), periodMs: WEEK, mayRemind: true });
    w.observe({ over: 2000, owes: 0, at: at(WEEK + DAY), periodMs: WEEK, mayRemind: true });

    const names = w.pullDomainEvents().map(event => event.name);
    expect(names).toEqual(['DebtNotedEvent', 'ReminderIssuedEvent', 'DebtClearedEvent']);
  });

  it('refuses a watch that is not for a member of a group', () => {
    expect(DebtWatch.open({ groupId: '', memberId: 'cy' }).isFailure()).toBe(true);
    expect(DebtWatch.open({ groupId: 'house', memberId: '' }).isFailure()).toBe(true);
  });
});

describe('the threshold of a reminder is 20 of the group’s currency, in its minor unit (request 40)', () => {
  it('is 20 yen in JPY, 20 won in KRW, 20 dinars in KWD, and 20 euros in EUR', () => {
    expect(lingeringDebtOver('JPY')).toBe(20);
    expect(lingeringDebtOver('KRW')).toBe(20);
    expect(lingeringDebtOver('KWD')).toBe(20000);
    expect(lingeringDebtOver('EUR')).toBe(2000);
  });

  it('notes a debt of 21 yen, and not one of 20 yen', () => {
    const opened = DebtWatch.open({ groupId: 'trip', memberId: 'ana' });
    if (opened.isFailure()) throw opened.error;
    const w = opened.data;
    expect(
      w.observe({ over: lingeringDebtOver('JPY'), owes: 20, at: at(0), periodMs: WEEK, mayRemind: true }).changed,
    ).toBe(false);
    expect(
      w.observe({ over: lingeringDebtOver('JPY'), owes: 21, at: at(0), periodMs: WEEK, mayRemind: true }).changed,
    ).toBe(true);
  });
});
