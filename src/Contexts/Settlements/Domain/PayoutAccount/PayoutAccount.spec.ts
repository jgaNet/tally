import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

const SNAPSHOT_ID = '5a1f2c3e-0000-4000-8000-000000000001';

describe('PayoutAccount', () => {
  it('opens for its owner with no account, at version 0, recording nothing', () => {
    const account = PayoutAccount.open('ann');
    expect(account.owner).toBe('ann');
    expect(account.accountId).toBeNull();
    expect(account.version).toBe(0);
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('keeps the account the provider knows, and records PayoutAccountSet with it', () => {
    const account = PayoutAccount.open('ann');
    expect(account.set({ accountId: 'acct_ann', providerAnswer: true }).isSuccess()).toBe(true);
    expect(account.accountId).toBe('acct_ann');
    expect(account.pullDomainEvents().map(event => event.name)).toEqual(['PayoutAccountSetEvent']);
  });

  it('is refused as UnknownPayoutAccount when the provider does not know the account, and keeps nothing', () => {
    const account = PayoutAccount.open('ann');
    const refused = account.set({ accountId: 'acct_x', providerAnswer: false });
    expect(refused.isFailure() && refused.error.type).toBe('UnknownPayoutAccount');
    expect(account.accountId).toBeNull();
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('is refused as ProviderUnavailable when the provider did not answer as asked, and keeps nothing', () => {
    const account = PayoutAccount.open('ann');
    const refused = account.set({ accountId: 'acct_x', providerAnswer: null });
    expect(refused.isFailure() && refused.error.type).toBe('ProviderUnavailable');
    expect(account.accountId).toBeNull();
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('is refused for an empty account id, and asks nothing to be kept', () => {
    const account = PayoutAccount.open('ann');
    const refused = account.set({ accountId: '', providerAnswer: true });
    expect(refused.isFailure() && refused.error.type).toBe('UnknownPayoutAccount');
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('replaces the account it held, and keeps the one held when the new one is refused', () => {
    const account = PayoutAccount.fromSnapshot({
      _id: SNAPSHOT_ID,
      owner: 'ann',
      accountId: 'acct_old',
      version: 3,
    });
    expect(account.pullDomainEvents()).toEqual([]);

    expect(account.set({ accountId: 'acct_bad', providerAnswer: false }).isFailure()).toBe(true);
    expect(account.accountId).toBe('acct_old');

    expect(account.set({ accountId: 'acct_new', providerAnswer: true }).isSuccess()).toBe(true);
    expect(account.toSnapshot()).toEqual({ _id: SNAPSHOT_ID, owner: 'ann', accountId: 'acct_new', version: 3 });
  });
});
