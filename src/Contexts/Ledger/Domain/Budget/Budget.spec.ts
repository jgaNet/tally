import { describe, expect, it } from '@jest/globals';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';

const now = new Date('2026-11-17T10:00:00.000Z');

describe('Budget in an archived group (request 27)', () => {
  it('is not set in an archived group, and has no amount', () => {
    const budget = Budget.create('flat', 'rent');
    expect(budget.set(100, true, now).error?.type).toBe('GroupArchived');
    expect(budget.amount).toBeUndefined();
    expect(budget.pullDomainEvents()).toEqual([]);
  });

  it('is not removed in an archived group, and keeps its amount', () => {
    const budget = Budget.create('flat', 'rent');
    expect(budget.set(100, false, now).isSuccess()).toBe(true);
    budget.pullDomainEvents();
    expect(budget.unset(true, now).error?.type).toBe('GroupArchived');
    expect(budget.amount).toBe(100);
    expect(budget.pullDomainEvents()).toEqual([]);
  });
});
