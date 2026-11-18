import { describe, expect, it } from '@jest/globals';

import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/** A netting asked by a suspended account is refused by AccountSuspended, and nothing is made (feature 34, request 34). */
describe('a netting asked by a suspended account', () => {
  const draft = {
    by: 'ann',
    with: 'bob',
    currency: 'EUR',
    amount: 500,
    settlementIds: ['s1', 's2'],
    at: new Date('2026-11-18T10:00:00.000Z'),
  };

  it('is refused by AccountSuspended', () => {
    const made = Netting.make({ ...draft, bySuspended: true });

    expect(made.isFailure() && made.error.type).toBe('AccountSuspended');
  });

  it('is made for an account that is not suspended', () => {
    const made = Netting.make({ ...draft, bySuspended: false });

    expect(made.isSuccess()).toBe(true);
  });
});
