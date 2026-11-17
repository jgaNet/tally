import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { PayoutAccountView } from '@Contexts/Settlements/Domain/PayoutAccount/DTOs';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';
import { IPayoutAccounts } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccounts';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';

/** What a person gives to set its payout account: the provider's id of the account (request 16). */
export interface SetPayoutAccountInput {
  accountId: string;
}

/**
 * Sets the caller's payout account to the one the provider knows (request 16, docs/adr/0016). The account is read first, at its version;
 * the provider is asked next, and the account decides with its answer in hand: an account the provider does not know is refused
 * (`UnknownPayoutAccount`), and a provider that does not answer `200` or `404` in time refuses it too (`ProviderUnavailable`). Setting
 * another account replaces the one the caller had. Answers `204`: there is nothing to say back.
 */
export const setPayoutAccount = command(
  'SetPayoutAccount',
  (payouts: IPayoutAccounts, provider: IPaymentProvider) =>
    async ({ accountId }: SetPayoutAccountInput, context) => {
      const account = await payouts.get(callerOf(context));
      const known = await provider.findPayoutAccount(accountId);
      if (known.isFailure()) return known;

      const set = account.set({ providerAccountId: accountId, known: known.data });
      if (set.isFailure()) return set;

      const saved = await payouts.save(account);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);

/** Reads the caller's payout account: its owner alone reads it, and a person with none does not have one to read (request 16). */
export const getPayoutAccount = query(
  'GetPayoutAccount',
  (payouts: IPayoutAccountQueries) => async (_input: void, context) => {
    const account: PayoutAccountView | undefined = await payouts.findPayoutAccount(callerOf(context));
    if (!account)
      return Result.fail(new NotFoundException('Settlements', 'There is no payout account for this caller'));
    return Result.ok(account);
  },
);
