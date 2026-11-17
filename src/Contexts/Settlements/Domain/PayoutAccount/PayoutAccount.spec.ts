import { describe, expect, it } from '@jest/globals';

import { PayoutAccount, PayoutAccountSetEvent } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import {
  PayoutAccountNotFoundException,
  UnknownPayoutAccountException,
} from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

const NOW = new Date('2026-03-01T10:00:00.000Z');

describe('a payout account (request 16)', () => {
  it('is created with the provider id of an account the provider knows, its own identity, and records PayoutAccountSet', () => {
    const created = PayoutAccount.create({ ownerId: 'ann', providerAccount: { id: 'acct-ann' } }, NOW);

    expect(created.isFailure()).toBe(false);
    const account = created.data!;
    expect(account.ownerId).toBe('ann');
    expect(account.providerAccountId).toBe('acct-ann');
    expect(account.version).toBe(0);
    expect(account._id.value).toEqual(expect.any(String));
    const [event] = account.pullDomainEvents();
    expect(event).toBeInstanceOf(PayoutAccountSetEvent);
    expect(event.payload).toEqual({
      payoutAccountId: account._id.value,
      ownerId: 'ann',
      providerAccountId: 'acct-ann',
      at: NOW.toISOString(),
    });
  });

  it('is refused, and nothing created, when the provider does not know the account or gave no answer', () => {
    expect(PayoutAccount.create({ ownerId: 'ann', providerAccount: undefined }, NOW).error).toBeInstanceOf(
      UnknownPayoutAccountException,
    );
    expect(PayoutAccount.create({ ownerId: 'ann', providerAccount: { id: '' } }, NOW).error?.type).toBe(
      'UnknownPayoutAccount',
    );
  });

  it('is replaced by another account the provider knows, and keeps its identity', () => {
    const account = PayoutAccount.create({ ownerId: 'ann', providerAccount: { id: 'acct-ann' } }, NOW).data!;
    const id = account._id.value;

    expect(account.set({ id: 'acct-ann-2' }, NOW).isFailure()).toBe(false);

    expect(account.providerAccountId).toBe('acct-ann-2');
    expect(account._id.value).toBe(id);
    expect(account.pullDomainEvents()).toHaveLength(2);
  });

  it('keeps the account it had when another one is refused', () => {
    const account = PayoutAccount.create({ ownerId: 'ann', providerAccount: { id: 'acct-ann' } }, NOW).data!;

    expect(account.set(undefined, NOW).error).toBeInstanceOf(UnknownPayoutAccountException);

    expect(account.providerAccountId).toBe('acct-ann');
  });

  it('is read back from its snapshot without recording anything', () => {
    const account = PayoutAccount.fromSnapshot({
      id: 'payout-1',
      version: 3,
      ownerId: 'ann',
      providerAccountId: 'acct-ann',
    });

    expect(account.version).toBe(3);
    expect(account.providerAccountId).toBe('acct-ann');
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('a person with none has no account to read: the not-found refusal names it', () => {
    expect(new PayoutAccountNotFoundException().type).toBe('NotFound');
  });
});
