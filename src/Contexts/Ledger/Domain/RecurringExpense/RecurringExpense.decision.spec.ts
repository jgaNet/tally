import { RecurringExpense } from './RecurringExpense';
import {
  decideSetUpRecurringExpense,
  decideSweepRecurringExpense,
  decideStopRecurringExpense,
} from './RecurringExpense.decision';
import { monthAfter, occurrencesUpTo, startsOnOf } from './RecurringDay';

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const base = {
  description: 'Rent',
  amount: 100,
  split: { kind: 'equal' as const, memberIds: ['ada', 'grace'] },
  payer: 'ada',
};

describe('the days of a recurring expense', () => {
  it('moves a day to the same day of the next month, the year turning', () => {
    expect(monthAfter('2026-01-28')).toBe('2026-02-28');
    expect(monthAfter('2026-12-05')).toBe('2027-01-05');
  });

  it('lists the days it falls on up to today, and none when the next is later', () => {
    expect(occurrencesUpTo('2026-09-05', '2026-11-18')).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
    expect(occurrencesUpTo('2026-12-05', '2026-11-18')).toEqual([]);
  });

  it('accepts a start whose day of the month is 1 to 28 and no more than 365 days from today', () => {
    expect(startsOnOf('2026-11-01', '2026-11-18').isFailure()).toBe(false);
    expect(startsOnOf('2026-11-29', '2026-11-18').isFailure()).toBe(true);
    expect(startsOnOf('2026-02-30', '2026-11-18').isFailure()).toBe(true);
    expect(startsOnOf('2027-11-18', '2026-11-18').isFailure()).toBe(false);
    expect(startsOnOf('2027-11-20', '2026-11-18').isFailure()).toBe(true);
    expect(startsOnOf('2025-11-01', '2026-11-18').isFailure()).toBe(true);
  });
});

describe('setting up', () => {
  it('refuses a split whose member is not in the group, and one that leaves the payer out', () => {
    const memberIds = ['ada'];
    expect(
      decideSetUpRecurringExpense(
        { archived: false, memberIds },
        { ...base, startsOn: '2026-11-05' },
        at('2026-11-18'),
      ).isFailure(),
    ).toBe(true);
    const leavesPayerOut = { ...base, startsOn: '2026-11-05', split: { kind: 'equal' as const, memberIds: ['grace'] } };
    expect(
      decideSetUpRecurringExpense(
        { archived: false, memberIds: ['ada', 'grace'] },
        leavesPayerOut,
        at('2026-11-18'),
      ).isFailure(),
    ).toBe(true);
  });

  it('keeps the split as given, and its first day is its start', () => {
    const decision = decideSetUpRecurringExpense(
      { archived: false, memberIds: ['ada', 'grace'] },
      { ...base, startsOn: '2026-11-05' },
      at('2026-11-18'),
    );
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state.split).toEqual(base.split);
    const recurring = RecurringExpense.setUp({
      groupId: 'g',
      paidBy: 'ada',
      description: 'Rent',
      amount: 100,
      startsOn: '2026-11-05',
      split: base.split,
      category: 'other',
    });
    expect(recurring.toSnapshot().next).toBe('2026-11-05');
    expect(recurring.pullDomainEvents().map(event => event.name)).toEqual(['RecurringExpenseSetUpEvent']);
  });
});

describe('a run over a recurring expense', () => {
  const recurring = RecurringExpense.setUp({
    groupId: 'g',
    paidBy: 'ada',
    description: 'Rent',
    amount: 100,
    startsOn: '2026-09-05',
    split: base.split,
    category: 'other',
  }).toSnapshot();

  it('records each day that came, and ends when a member it concerns is not in the group', () => {
    const due = decideSweepRecurringExpense(
      { archived: false, recurring, memberIds: ['ada', 'grace'] },
      undefined,
      at('2026-11-18'),
    );
    expect(due.data!.state).toEqual({ kind: 'due', days: ['2026-09-05', '2026-10-05', '2026-11-05'] });
    const ended = decideSweepRecurringExpense(
      { archived: false, recurring, memberIds: ['ada'] },
      undefined,
      at('2026-11-18'),
    );
    expect(ended.data!.state).toEqual({ kind: 'ended' });
    expect(
      decideSweepRecurringExpense({ archived: false, recurring, memberIds: undefined }, undefined, at('2026-11-18'))
        .data!.state,
    ).toEqual({ kind: 'ended' });
  });

  it('refuses a stop by a member who is neither the payer nor the owner', () => {
    expect(
      decideStopRecurringExpense(
        { archived: false, paidBy: 'ada', ownerId: 'owner' },
        { by: 'grace' },
        at('2026-11-18'),
      ).isFailure(),
    ).toBe(true);
    expect(
      decideStopRecurringExpense(
        { archived: false, paidBy: 'ada', ownerId: 'owner' },
        { by: 'owner' },
        at('2026-11-18'),
      ).isFailure(),
    ).toBe(false);
  });
});
