import { Account } from './Account';
import { decideDeleteAccount } from './Account.decision';

/**
 * Request 35: a person deletes their account. It is refused while it owns a group with another member, and while a payment of theirs through the
 * provider waits; otherwise it is erased, keeping its id, its name shown as `Deleted account` and its email replaced by one only its id makes.
 */
const at = new Date('2026-04-01T10:00:00.000Z');
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const active = () => Account.fromSnapshot({ id, email: 'ada@example.org', name: 'Ada', passwordHash: 'hash' });

describe('decideDeleteAccount (request 35)', () => {
  it('refuses while the account owns a group with another member', () => {
    const decision = decideDeleteAccount(
      { account: active(), ownsGroupWithMembers: true, paymentWaiting: false },
      undefined,
      at,
    );
    expect(decision.isFailure()).toBe(true);
  });

  it('refuses while a payment through the provider waits', () => {
    const decision = decideDeleteAccount(
      { account: active(), ownsGroupWithMembers: false, paymentWaiting: true },
      undefined,
      at,
    );
    expect(decision.isFailure()).toBe(true);
  });

  it('decides nothing refused for an account that is not there, or is deleted already', () => {
    expect(
      decideDeleteAccount(
        { account: undefined, ownsGroupWithMembers: false, paymentWaiting: false },
        undefined,
        at,
      ).isFailure(),
    ).toBe(true);
    const erased = active();
    erased.delete(at);
    expect(
      decideDeleteAccount(
        { account: erased, ownsGroupWithMembers: false, paymentWaiting: false },
        undefined,
        at,
      ).isFailure(),
    ).toBe(true);
  });

  it('allows a deletion that nothing refuses', () => {
    const decision = decideDeleteAccount(
      { account: active(), ownsGroupWithMembers: false, paymentWaiting: false },
      undefined,
      at,
    );
    expect(decision.isFailure()).toBe(false);
  });
});

describe('Account.delete (request 35)', () => {
  it('erases the name and the email, keeps the id, and records AccountDeleted', () => {
    const account = active();
    account.delete(at);
    expect(account.isDeleted).toBe(true);
    expect(account.name.value).toBe('Deleted account');
    expect(account.email.value).toBe(`${id}@deleted.invalid`);
    expect(account._id.value).toBe(id);
    expect(account.toSnapshot()).toMatchObject({ id, name: 'Deleted account', deletedAt: at.toISOString() });
    expect(account.toSnapshot().passwordHash).not.toBe('hash');
  });

  it('is read back as deleted from what was stored', () => {
    const erased = active();
    erased.delete(at);
    const reread = Account.fromSnapshot(erased.toSnapshot());
    expect(reread.isDeleted).toBe(true);
    expect(reread.email.value).toBe(`${id}@deleted.invalid`);
  });
});
