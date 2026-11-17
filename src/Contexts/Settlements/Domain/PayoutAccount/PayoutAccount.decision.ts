import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { UnknownPayoutAccountException } from './PayoutAccountExceptions';

/** What setting a payout account says: whose it is (the caller), and the provider's id of the account. */
export interface SetPayoutAccountCommand {
  ownerId: string;
  accountId: string;
}

/**
 * What the decision is given: the provider's id of the account it was asked about, or `undefined` when it knows none, answered anything
 * else, or did not answer in time (request 16). The use case asks the provider before the decision; the decision is a pure function of it.
 */
export interface PayoutAccountGiven {
  providerAccount: string | undefined;
}

/**
 * Setting a payout account (request 16): the provider must know the account asked for, and say so with the same id; otherwise it is
 * refused and nothing changes. Answers the values the account is set to.
 */
export const decideSetPayoutAccount: Decision<
  SetPayoutAccountCommand,
  SetPayoutAccountCommand,
  never,
  PayoutAccountGiven
> = ({ providerAccount }, { ownerId, accountId }) => {
  if (providerAccount === undefined || providerAccount !== accountId) {
    return Result.fail(new UnknownPayoutAccountException());
  }
  return decided({ ownerId, accountId });
};
