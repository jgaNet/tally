import { describe, expect, it } from '@jest/globals';

import { Account } from '@Contexts/Groups/Domain/Account/Account';

/** The suspension of an account, as the aggregate decides it (feature 34, request 34): once, and only a change records a fact. */
const now = new Date('2026-11-18T10:00:00.000Z');
const later = new Date('2026-11-19T10:00:00.000Z');
const snapshot = { id: 'ann', email: 'ann@example.com', name: 'Ann', passwordHash: 'hash', version: 1 };

describe('suspending an account', () => {
  it('suspends a free account once, recording AccountSuspended with the time, and the account says so', () => {
    const account = Account.fromSnapshot(snapshot);

    expect(account.suspend(now)).toBe(true);
    expect(account.isSuspended()).toBe(true);
    expect(account.toSnapshot()).toMatchObject({ suspendedAt: now.toISOString() });
    const [fact] = account.pullDomainEvents();
    expect(fact.payload).toEqual({ accountId: 'ann', at: now.toISOString() });
  });

  it('changes nothing for an account already suspended: no change, no fact, the first time kept', () => {
    const account = Account.fromSnapshot({ ...snapshot, suspendedAt: now.toISOString() });

    expect(account.suspend(later)).toBe(false);
    expect(account.toSnapshot()).toMatchObject({ suspendedAt: now.toISOString() });
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('reinstates a suspended account once, recording AccountReinstated, and changes nothing when it is not suspended', () => {
    const suspended = Account.fromSnapshot({ ...snapshot, suspendedAt: now.toISOString() });

    expect(suspended.reinstate(later)).toBe(true);
    expect(suspended.isSuspended()).toBe(false);
    expect(suspended.toSnapshot()).not.toHaveProperty('suspendedAt');
    const [fact] = suspended.pullDomainEvents();
    expect(fact.payload).toEqual({ accountId: 'ann', at: later.toISOString() });

    const free = Account.fromSnapshot(snapshot);
    expect(free.reinstate(later)).toBe(false);
    expect(free.pullDomainEvents()).toEqual([]);
  });
});
