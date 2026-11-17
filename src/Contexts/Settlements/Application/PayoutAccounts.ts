import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IPaymentProvider } from '@Contexts/Settlements/Application/IPaymentProvider';
import { IPayoutAccountStore } from '@Contexts/Settlements/Application/IPayoutAccountStore';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { PayoutAccountNotFoundException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

/** The payout account as the request carries it: the provider's id of the account the caller is paid on. */
export interface SetPayoutAccountInput {
  readonly accountId: string;
}

/** What a screen shows of a payout account: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface PayoutAccountView {
  readonly accountId: string;
}

/**
 * Sets the payout account the caller is paid on (request 16, the storm's `SetPayoutAccount`). The provider is asked whether it knows
 * the account, through the port; an account it does not know, or does not confirm, is refused (`422`) and nothing is set. Setting
 * another account replaces the one the caller had. Answers nothing (`204`).
 */
export const setPayoutAccount = command(
  'SetPayoutAccount',
  (payouts: IPayoutAccountStore, provider: IPaymentProvider, clock: Clock) =>
    async ({ accountId }: SetPayoutAccountInput, context): Promise<IResult<void>> => {
      const ownerId = callerOf(context);
      const providerAccount = accountId ? await provider.payoutAccountFor(accountId) : undefined;
      const existing = await payouts.payoutAccountOf(ownerId);

      let account: PayoutAccount;
      if (existing) {
        const replaced = existing.set(providerAccount, clock());
        if (replaced.isFailure()) return Result.fail(replaced.error);
        account = existing;
      } else {
        const created = PayoutAccount.create({ ownerId, providerAccount }, clock());
        if (created.isFailure()) return Result.fail(created.error);
        account = created.data;
      }

      await payouts.save(account);
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);

/**
 * The caller's own payout account, as the provider's id of it (request 16, the storm's `GetPayoutAccount`). Nobody reads another
 * person's: the account is the caller's, and a caller with none is answered `404`.
 */
export const getPayoutAccount = query(
  'GetPayoutAccount',
  (payouts: IPayoutAccountStore) =>
    async (_: undefined, context): Promise<IResult<PayoutAccountView>> => {
      const account = await payouts.payoutAccountOf(callerOf(context));
      if (!account) return Result.fail(new PayoutAccountNotFoundException());
      return Result.ok({ accountId: account.providerAccountId });
    },
);
