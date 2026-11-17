import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { decideSetPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount.decision';

import { IPaymentProvider } from './IPaymentProvider';
import { IPayoutAccounts } from './IPayoutAccounts';

/** What a member sets as their payout account: the provider's id of it (request 16). */
export interface SetPayoutAccountInput {
  accountId: string;
}

/**
 * A signed-in person sets the account the provider pays them on (request 16): the provider must know it, which is asked before the
 * decision and given to it; otherwise the request is refused and the account they had stays. Setting another account replaces the one
 * they had. Answers nothing (`204`). The account is saved with the version it was read at, so two settings at once are decided one after
 * the other (CONC-OPTIMISTIC).
 */
export const setPayoutAccount = command(
  'SetPayoutAccount',
  (accounts: IPayoutAccounts, provider: IPaymentProvider, clock: Clock) =>
    async ({ accountId }: SetPayoutAccountInput, context) => {
      const ownerId = callerOf(context);
      const providerAccount = await provider.payoutAccountOf(accountId);
      const decision = decideSetPayoutAccount({ providerAccount }, { ownerId, accountId }, clock());
      if (decision.isFailure()) return decision;

      const stored = await accounts.ofOwner(ownerId);
      let account: PayoutAccount;
      if (stored) {
        stored.replaceWith(decision.data.state.accountId);
        account = stored;
      } else {
        account = PayoutAccount.create({ ownerId, accountId: decision.data.state.accountId });
      }
      await accounts.save(account);
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);

/**
 * A signed-in person reads their own payout account (request 16): the provider's id of it. Nobody reads another's; one who has none gets
 * the answer for an account that does not exist (`404`).
 */
export const getPayoutAccount = query(
  'GetPayoutAccount',
  (accounts: IPayoutAccounts) => async (_input: void, context) => {
    const account = await accounts.ofOwner(callerOf(context));
    if (!account) return Result.fail(new NotFoundException('Settlements', 'No payout account is set'));
    return Result.ok({ accountId: account.accountId });
  },
);
