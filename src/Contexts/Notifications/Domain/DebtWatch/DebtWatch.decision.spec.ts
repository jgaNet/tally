import { decideSeeDebt, reminderThresholdOf, WatchState } from './DebtWatch.decision';

const WEEK = 7 * 24 * 3600 * 1000;
const t0 = new Date('2026-03-02T10:00:00.000Z');
const after = (ms: number) => new Date(t0.getTime() + ms);

const see = (kept: WatchState | undefined, owed: number, now: Date) => {
  const decision = decideSeeDebt(kept, { owed, threshold: 2000, periodMs: WEEK, remindable: true }, now);
  if (decision.isFailure()) throw decision.error;
  return decision.data;
};

describe('decideSeeDebt', () => {
  it('notes a member it sees owe more than 2000 and had not seen so, and reminds nobody that run', () => {
    const { state, facts } = see(undefined, 2001, t0);
    expect(state).toEqual({ notedSince: t0.toISOString(), remindedAt: null });
    expect(facts).toEqual([{ type: 'DebtNoted' }]);
  });

  it('does nothing for a member it sees owe 2000 or less and had not noted', () => {
    expect(see(undefined, 2000, t0).facts).toEqual([]);
    expect(see({ notedSince: null, remindedAt: null }, 0, t0).facts).toEqual([]);
  });

  it('does nothing while the debt has lasted less than a period', () => {
    const noted = { notedSince: t0.toISOString(), remindedAt: null };
    expect(see(noted, 5000, after(WEEK - 1)).facts).toEqual([]);
  });

  it('reminds, of what is owed now, once the debt has lasted a period, and not again before another', () => {
    const noted = { notedSince: t0.toISOString(), remindedAt: null };
    const reminded = see(noted, 2500, after(WEEK));
    expect(reminded.facts).toEqual([{ type: 'ReminderDue', owed: 2500 }]);
    expect(reminded.state.remindedAt).toBe(after(WEEK).toISOString());

    expect(see(reminded.state, 2500, after(2 * WEEK - 1)).facts).toEqual([]);
    expect(see(reminded.state, 2500, after(2 * WEEK)).facts).toEqual([{ type: 'ReminderDue', owed: 2500 }]);
  });

  it('stops noting a member it sees owe 2000 or less, and keeps the last reminder', () => {
    const { state, facts } = see(
      { notedSince: t0.toISOString(), remindedAt: after(WEEK).toISOString() },
      2000,
      after(WEEK + 1),
    );
    expect(facts).toEqual([{ type: 'DebtCleared' }]);
    expect(state).toEqual({ notedSince: null, remindedAt: after(WEEK).toISOString() });
  });

  it('waits a period from the run that sees a debt come back, and from the last reminder', () => {
    const cleared = { notedSince: null, remindedAt: after(WEEK).toISOString() };
    const back = see(cleared, 3000, after(WEEK + 10));
    expect(back.facts).toEqual([{ type: 'DebtNoted' }]);
    expect(see(back.state, 3000, after(WEEK + 10 + WEEK - 1)).facts).toEqual([]);
    expect(see(back.state, 3000, after(WEEK + 10 + WEEK)).facts).toEqual([{ type: 'ReminderDue', owed: 3000 }]);
  });

  it('makes no reminder while reminders are off for the member, and the debt stays noted, so the next run on reminds', () => {
    const noted = { notedSince: t0.toISOString(), remindedAt: null };
    const off = decideSeeDebt(noted, { owed: 2500, threshold: 2000, periodMs: WEEK, remindable: false }, after(WEEK));
    if (off.isFailure()) throw off.error;
    expect(off.data.facts).toEqual([]);
    expect(off.data.state).toEqual(noted);

    const on = decideSeeDebt(
      off.data.state,
      { owed: 2500, threshold: 2000, periodMs: WEEK, remindable: true },
      after(WEEK + 60_000),
    );
    if (on.isFailure()) throw on.error;
    expect(on.data.facts).toEqual([{ type: 'ReminderDue', owed: 2500 }]);
  });
});

describe('reminderThresholdOf (request 40)', () => {
  it('is more than 20 of the currency, in its minor unit: 2000 in hundredths, 20 with none, 20 000 in thousandths', () => {
    expect(reminderThresholdOf('EUR')).toBe(2000);
    expect(reminderThresholdOf('USD')).toBe(2000);
    expect(reminderThresholdOf('JPY')).toBe(20);
    expect(reminderThresholdOf('KRW')).toBe(20);
    expect(reminderThresholdOf('KWD')).toBe(20000);
    expect(reminderThresholdOf('BHD')).toBe(20000);
  });

  it('notes a yen debt of 21 yen as more than the threshold, and not one of 20 yen', () => {
    const threshold = reminderThresholdOf('JPY');
    const noted = decideSeeDebt(undefined, { owed: 21, threshold, periodMs: WEEK, remindable: true }, t0).data!;
    expect(noted.facts).toEqual([{ type: 'DebtNoted' }]);
    const notNoted = decideSeeDebt(undefined, { owed: 20, threshold, periodMs: WEEK, remindable: true }, t0).data!;
    expect(notNoted.facts).toEqual([]);
  });
});
