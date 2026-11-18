import { describe, expect, it } from '@jest/globals';

import {
  RecurringExpense,
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  nextMonthOf,
} from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

const now = new Date('2026-11-18T10:00:00.000Z');
const members = ['ann', 'bob'];
const draft = (overrides: Record<string, unknown> = {}) => ({
  groupId: 'group',
  payerId: 'ann',
  description: 'Rent',
  amount: 90000,
  startsOn: '2026-09-05',
  split: { kind: 'equal' as const, memberIds: ['ann', 'bob'] },
  ...overrides,
});

const setUpOrThrow = (overrides: Record<string, unknown> = {}): RecurringExpense => {
  const set = RecurringExpense.setUp(draft(overrides) as never, members, false, now);
  if (set.isFailure()) throw set.error;
  return set.data;
};

/** The set up one, as the store would keep it and load it again: version 1, next as it stands. */
const loaded = (recurring: RecurringExpense): RecurringExpense =>
  RecurringExpense.fromSnapshot({ ...recurring.toSnapshot(), version: 1 });

describe('RecurringExpense.setUp', () => {
  it('sets up a recurring expense whose next day is its start, recording RecurringExpenseSetUp', () => {
    const recurring = setUpOrThrow();
    expect(recurring.toSnapshot()).toMatchObject({
      paidBy: 'ann',
      description: 'Rent',
      amount: 90000,
      startsOn: '2026-09-05',
      next: '2026-09-05',
    });
    expect(recurring.pullDomainEvents()).toHaveLength(1);
  });

  it('accepts a start exactly 365 days before today and exactly 365 days after it', () => {
    expect(RecurringExpense.setUp(draft({ startsOn: '2025-11-18' }) as never, members, false, now).isSuccess()).toBe(
      true,
    );
    expect(RecurringExpense.setUp(draft({ startsOn: '2027-11-18' }) as never, members, false, now).isSuccess()).toBe(
      true,
    );
  });

  it('refuses a start more than 365 days before today or after it', () => {
    const before = RecurringExpense.setUp(draft({ startsOn: '2025-11-17' }) as never, members, false, now);
    const after = RecurringExpense.setUp(draft({ startsOn: '2027-11-19' }) as never, members, false, now);
    expect(before.isFailure() && before.error.type).toBe('InvalidRecurringStartsOn');
    expect(after.isFailure() && after.error.type).toBe('InvalidRecurringStartsOn');
  });

  it('refuses a start that is not a day every month has, or a day that is not on the calendar', () => {
    for (const startsOn of ['2026-09-29', '2026-09-31', '2026-02-30', '2026-09-00', '2026-9-05', 'not a day']) {
      const set = RecurringExpense.setUp(draft({ startsOn }) as never, members, false, now);
      expect(set.isFailure() && set.error.type).toBe('InvalidRecurringStartsOn');
    }
  });

  it('refuses an amount that is not a whole number from 1, and a description that is empty', () => {
    const amount = RecurringExpense.setUp(draft({ amount: 0 }) as never, members, false, now);
    const description = RecurringExpense.setUp(draft({ description: '   ' }) as never, members, false, now);
    expect(amount.isFailure() && amount.error.type).toBe('InvalidExpenseAmount');
    expect(description.isFailure() && description.error.type).toBe('InvalidExpenseDescription');
  });

  it('refuses a split that names a member who is not in the group, and one whose payer is not in it', () => {
    const outsider = RecurringExpense.setUp(
      draft({ split: { kind: 'equal', memberIds: ['ann', 'carl'] } }) as never,
      members,
      false,
      now,
    );
    const payerLeft = RecurringExpense.setUp(
      draft({ split: { kind: 'equal', memberIds: ['bob'] } }) as never,
      members,
      false,
      now,
    );
    expect(outsider.isFailure() && outsider.error.type).toBe('SplitMemberNotInGroup');
    expect(payerLeft.isFailure() && payerLeft.error.type).toBe('PayerNotInSplit');
  });

  it('keeps the split as it was given, not decided', () => {
    const recurring = setUpOrThrow({
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 2 },
          { memberId: 'bob', shares: 1 },
        ],
      },
    });
    expect(recurring.toSnapshot().split).toEqual({
      kind: 'shares',
      shares: [
        { memberId: 'ann', shares: 2 },
        { memberId: 'bob', shares: 1 },
      ],
    });
  });
});

describe('RecurringExpense.sweep', () => {
  it('records a day for each day of the month that has come since its start, and moves next past today', () => {
    const recurring = loaded(setUpOrThrow());
    recurring.pullDomainEvents();

    expect(recurring.sweep(members, false, now)).toBe('kept');

    const events = recurring.pullDomainEvents() as RecurringExpenseDayCameEvent[];
    expect(events.map(event => event.payload.day)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
    expect(recurring.next).toBe('2026-12-05');
    const ids = events.map(event => event.payload.expenseId);
    expect(new Set(ids).size).toBe(3);
    expect(events[0].payload).toMatchObject({ paidBy: 'ann', description: 'Rent', amount: 90000 });
  });

  it('records nothing before its day has come', () => {
    const recurring = loaded(setUpOrThrow({ startsOn: '2026-12-05' }));
    expect(recurring.sweep(members, false, now)).toBe('kept');
    expect(recurring.pullDomainEvents()).toHaveLength(0);
    expect(recurring.next).toBe('2026-12-05');
  });

  it('records a day on the very day it comes', () => {
    const recurring = loaded(setUpOrThrow({ startsOn: '2026-11-18' }));
    recurring.sweep(members, false, now);
    expect((recurring.pullDomainEvents() as RecurringExpenseDayCameEvent[]).map(event => event.payload.day)).toEqual([
      '2026-11-18',
    ]);
    expect(recurring.next).toBe('2026-12-18');
  });

  it('ends, recording no expense, when a member of its split has left the group', () => {
    const recurring = loaded(setUpOrThrow());
    recurring.pullDomainEvents();

    expect(recurring.sweep(['ann'], false, now)).toBe('ended');

    const events = recurring.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(RecurringExpenseEndedEvent);
  });

  it('ends when the group is not there', () => {
    const recurring = loaded(setUpOrThrow());
    expect(recurring.sweep(undefined, false, now)).toBe('ended');
  });
});

describe('nextMonthOf', () => {
  it('is the same day of the next month, the year turning in December', () => {
    expect(nextMonthOf('2026-09-05')).toBe('2026-10-05');
    expect(nextMonthOf('2026-12-28')).toBe('2027-01-28');
  });
});

describe('RecurringExpense in an archived group (request 27)', () => {
  it('is not set up in an archived group', () => {
    expect(RecurringExpense.setUp(draft() as never, members, true, now).error?.type).toBe('GroupArchived');
  });

  it('is not stopped in an archived group, and stays as it was', () => {
    const recurring = setUpOrThrow();
    recurring.pullDomainEvents();
    expect(recurring.stop(true, now).error?.type).toBe('GroupArchived');
    expect(recurring.pullDomainEvents()).toEqual([]);
  });

  it('is left alone by the sweep in an archived group: nothing recorded, next day not moved', () => {
    const recurring = loaded(setUpOrThrow({ startsOn: '2026-09-05' }));
    const next = recurring.next;
    expect(recurring.sweep(members, true, now)).toBe('archived');
    expect(recurring.next).toBe(next);
    expect(recurring.pullDomainEvents()).toEqual([]);
  });
});
