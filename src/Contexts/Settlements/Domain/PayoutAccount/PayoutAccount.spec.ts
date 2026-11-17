import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

describe('a payout account', () => {
  it('starts with none, at version 0, and is set to an account the provider knows, recording the set', () => {
    const account = PayoutAccount.fromSnapshot({ accountId: 'ann', version: 0 });
    expect(account.providerAccountId).toBeUndefined();

    const set = account.set({ providerAccountId: 'acct-ann', known: 'acct-ann' });
    expect(set.isSuccess()).toBe(true);
    expect(account.providerAccountId).toBe('acct-ann');
    expect(account.pullDomainEvents()).toHaveLength(1);
  });

  it('is refused when the provider does not know the account, and changes nothing', () => {
    const account = PayoutAccount.fromSnapshot({ accountId: 'ann', version: 2, providerAccountId: 'acct-old' });

    const unknown = account.set({ providerAccountId: 'acct-new', known: undefined });
    expect(unknown.isFailure() && unknown.error.type).toBe('UnknownPayoutAccount');
    expect(account.providerAccountId).toBe('acct-old');
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('is refused when the provider answers another account than the one asked for', () => {
    const account = PayoutAccount.fromSnapshot({ accountId: 'ann', version: 0 });
    const other = account.set({ providerAccountId: 'acct-ann', known: 'acct-someone-else' });
    expect(other.isFailure() && other.error.type).toBe('UnknownPayoutAccount');
    expect(account.providerAccountId).toBeUndefined();
  });

  it('is read from the store as it was kept, and throws on corrupted data', () => {
    expect(PayoutAccount.fromSnapshot({ accountId: 'ann', version: 3, providerAccountId: 'acct-ann' }).version).toBe(3);
    expect(() => PayoutAccount.fromSnapshot({ accountId: 'ann', version: 0, providerAccountId: 'acct-ann' })).toThrow();
    expect(() => PayoutAccount.fromSnapshot({ accountId: 'ann', version: 2 })).toThrow();
    expect(() => PayoutAccount.fromSnapshot({ accountId: '', version: 0 })).toThrow();
  });
});
