import { Id } from '@Architecture/Domain';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

const owner = new Id('owner');

describe('PayoutAccount: a payout account is one the provider knows, and setting another replaces it (request 16)', () => {
  it('is set on the account the provider knows, and records PayoutAccountSet', () => {
    const created = PayoutAccount.create({ owner, accountId: 'acct-1', providerAnswer: { id: 'acct-1' } });
    if (created.isFailure()) throw new Error('refused');

    expect(created.data).toMatchObject({ accountId: 'acct-1' });
    expect(created.data.pullDomainEvents().map(event => event.name)).toEqual(['PayoutAccountSetEvent']);
  });

  it('refuses an account the provider does not know, with UnknownPayoutAccount, and keeps nothing', () => {
    const refused = PayoutAccount.create({ owner, accountId: 'acct-9', providerAnswer: null });

    expect(refused.isFailure()).toBe(true);
    expect((refused.error as { type?: string } | undefined)?.type).toBe('UnknownPayoutAccount');
  });

  it('refuses an answer for another account than the one asked for', () => {
    const refused = PayoutAccount.create({ owner, accountId: 'acct-1', providerAnswer: { id: 'acct-2' } });

    expect(refused.isFailure()).toBe(true);
    expect((refused.error as { type?: string } | undefined)?.type).toBe('UnknownPayoutAccount');
  });

  it('replaces the account a person had with another the provider knows, keeping its identity', () => {
    const account = PayoutAccount.fromSnapshot({ id: 'pa-1', owner: 'owner', accountId: 'acct-1', version: 3 });

    const changed = account.change({ accountId: 'acct-2', providerAnswer: { id: 'acct-2' } });

    expect(changed.isSuccess()).toBe(true);
    expect(account.accountId).toBe('acct-2');
    expect(account._id.value).toBe('pa-1');
    expect(account.version).toBe(3);
    expect(account.pullDomainEvents().map(event => event.name)).toEqual(['PayoutAccountSetEvent']);
  });

  it('keeps the account it had when the provider does not know the one it is set to', () => {
    const account = PayoutAccount.fromSnapshot({ id: 'pa-1', owner: 'owner', accountId: 'acct-1', version: 1 });

    const changed = account.change({ accountId: 'acct-9', providerAnswer: null });

    expect(changed.isFailure()).toBe(true);
    expect(account.accountId).toBe('acct-1');
    expect(account.pullDomainEvents()).toHaveLength(0);
  });

  it('is rebuilt from storage without recording anything', () => {
    const account = PayoutAccount.fromSnapshot({ id: 'pa-1', owner: 'owner', accountId: 'acct-1', version: 2 });

    expect(account.pullDomainEvents()).toHaveLength(0);
    expect(account.owner.value).toBe('owner');
  });
});
