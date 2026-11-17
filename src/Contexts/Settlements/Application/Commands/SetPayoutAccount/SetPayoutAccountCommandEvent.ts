import { CommandEvent } from '@Architecture/Domain';

/**
 * A signed-in person sets the payout account they are paid on: the provider's id of it. The caller is the owner; the provider must
 * know the account, or it is refused.
 */
export class SetPayoutAccountCommandEvent extends CommandEvent<{
  accountId: string;
}> {}
