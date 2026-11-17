import { describe, expect, it } from '@jest/globals';

import { Account, AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Account';

/** The account's rules, as the aggregate holds them: what a sign-up allows, what it refuses, and the round-trip. */
const now = new Date('2026-05-01T10:00:00.000Z');
const valid = { email: 'Ann@Example.com', password: 'a long enough password', passwordHash: 'hash', name: 'Ann' };
const notTaken = { emailTaken: false };

describe('Account.create', () => {
  it('allows a sign-up, normalises the email, and records AccountRegistered with the id and the time', () => {
    const created = Account.create(valid, notTaken, now);

    expect(created.isSuccess()).toBe(true);
    const account = created.data!;
    expect(account.toSnapshot()).toEqual({
      id: expect.any(String),
      email: 'ann@example.com',
      name: 'Ann',
      passwordHash: 'hash',
      version: 0,
    });
    const [event] = account.pullDomainEvents();
    expect(event).toBeInstanceOf(AccountRegisteredEvent);
    expect(event.payload).toEqual({ accountId: account.toSnapshot().id, at: '2026-05-01T10:00:00.000Z' });
  });

  it('gives each account an identity of its own', () => {
    const first = Account.create(valid, notTaken, now).data!.toSnapshot().id;
    const second = Account.create(valid, notTaken, now).data!.toSnapshot().id;
    expect(first).not.toEqual(second);
  });

  it('refuses an email that does not look like one, as the shared kernel says', () => {
    const refused = Account.create({ ...valid, email: 'not-an-email' }, notTaken, now);
    expect(refused.isFailure() && refused.error.type).toBe('InvalidEmailFormat');
  });

  it('refuses a password of fewer than 8 characters', () => {
    const refused = Account.create({ ...valid, password: 'short' }, notTaken, now);
    expect(refused.isFailure() && refused.error.type).toBe('WeakPassword');
    expect(Account.create({ ...valid, password: '12345678' }, notTaken, now).isSuccess()).toBe(true);
  });

  it.each([
    ['an empty name', ''],
    ['a name of only spaces', '   '],
    ['a name of 61 characters', 'x'.repeat(61)],
  ])('refuses %s', (_, name) => {
    const refused = Account.create({ ...valid, name }, notTaken, now);
    expect(refused.isFailure() && refused.error.type).toBe('InvalidName');
  });

  it('accepts a name of 60 characters', () => {
    expect(Account.create({ ...valid, name: 'x'.repeat(60) }, notTaken, now).isSuccess()).toBe(true);
  });

  it('refuses an email an account already uses, as a conflict', () => {
    const refused = Account.create(valid, { emailTaken: true }, now);
    expect(refused.isFailure() && refused.error.type).toBe('EmailAlreadyRegistered');
  });
});

describe('Account.fromSnapshot', () => {
  it('gives back the account it was kept as, and records nothing', () => {
    const snapshot = {
      id: '6f1c0a52-0000-4000-8000-000000000001',
      email: 'ann@example.com',
      name: 'Ann',
      passwordHash: 'h',
      version: 3,
    };
    const account = Account.fromSnapshot(snapshot);

    expect(account.toSnapshot()).toEqual(snapshot);
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('throws on corrupted data: a stored email that is not one is a programming error, not a refusal', () => {
    expect(() =>
      Account.fromSnapshot({ id: 'x', email: 'broken', name: 'Ann', passwordHash: 'h', version: 0 }),
    ).toThrow('corrupted');
  });
});
