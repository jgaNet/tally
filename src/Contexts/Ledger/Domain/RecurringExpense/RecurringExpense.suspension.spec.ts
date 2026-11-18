import { describe, expect, it } from '@jest/globals';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/**
 * A recurring expense whose payer is suspended (feature 34, request 34): it is set up refused, and the sweep decides nothing for it. Its days
 * wait, unmoved, so the first sweep after the reinstatement records every day that has come.
 */
const now = new Date('2026-11-18T10:00:00.000Z');
const members = ['ann', 'bob'];
const draft = {
  groupId: 'group',
  payerId: 'ann',
  description: 'Rent',
  amount: 90000,
  startsOn: '2026-09-05',
  split: { kind: 'equal' as const, memberIds: ['ann', 'bob'] },
};

describe('a recurring expense of a suspended payer', () => {
  it('is refused to be set up by AccountSuspended, and nothing is set up', () => {
    const set = RecurringExpense.setUp(draft as never, members, false, true, now);

    expect(set.isFailure() && set.error.type).toBe('AccountSuspended');
  });

  it('is left alone by the sweep while its payer is suspended: no day recorded, no move, no fact', () => {
    const set = RecurringExpense.setUp(draft as never, members, false, false, now);
    if (set.isFailure()) throw set.error;
    const recurring = set.data;
    recurring.pullDomainEvents();
    const before = recurring.toSnapshot();

    expect(recurring.sweep(members, false, true, now)).toBe('suspended');
    expect(recurring.toSnapshot()).toEqual(before);
    expect(recurring.pullDomainEvents()).toEqual([]);
  });

  it('records every day that has come once the payer is reinstated, from the day it was left at', () => {
    const set = RecurringExpense.setUp(draft as never, members, false, false, now);
    if (set.isFailure()) throw set.error;
    const recurring = set.data;
    recurring.pullDomainEvents();

    expect(recurring.sweep(members, false, false, now)).toBe('kept');
    const days = recurring.pullDomainEvents().map(event => (event.payload as { day: string }).day);
    expect(days).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });
});
