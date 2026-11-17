import { decideSetPayoutAccount } from './PayoutAccount.decision';
import { PayoutAccount } from './PayoutAccount';

const ask = (providerAccount: string | undefined, accountId = 'acct_1') =>
  decideSetPayoutAccount({ providerAccount }, { ownerId: 'ada', accountId }, new Date('2026-01-01T00:00:00Z'));

describe('decideSetPayoutAccount (request 16)', () => {
  it('allows an account the provider knows, and says whose it is and which account', () => {
    const decision = ask('acct_1');
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({ ownerId: 'ada', accountId: 'acct_1' });
  });

  it('refuses an account the provider does not know, or that it did not answer for, by name', () => {
    expect((ask(undefined).error as { type: string }).type).toBe('UnknownPayoutAccount');
    expect((ask('acct_2').error as { type: string }).type).toBe('UnknownPayoutAccount');
  });
});

describe('PayoutAccount', () => {
  it('is set with its own id and records that it was set', () => {
    const account = PayoutAccount.create({ ownerId: 'ada', accountId: 'acct_1' });
    expect(account.version).toBe(0);
    expect(account.accountId).toBe('acct_1');
    expect(account.pullDomainEvents()).toHaveLength(1);
  });

  it('is replaced with another account, and records it', () => {
    const account = PayoutAccount.fromSnapshot({ id: 'p-1', ownerId: 'ada', accountId: 'acct_1', version: 3 });
    account.replaceWith('acct_2');
    expect(account.accountId).toBe('acct_2');
    expect(account.version).toBe(3);
    expect(account.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses a stored account at a version no save could store', () => {
    expect(() => PayoutAccount.fromSnapshot({ id: 'p-1', ownerId: 'ada', accountId: 'a', version: 0 })).toThrow();
  });
});
