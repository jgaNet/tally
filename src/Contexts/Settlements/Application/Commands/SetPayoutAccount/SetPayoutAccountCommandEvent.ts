import { CommandEvent } from '@Architecture/Domain';

/** A signed-in person sets the payout account the provider pays them on: the provider's id of that account. */
export class SetPayoutAccountCommandEvent extends CommandEvent<{ accountId: string }> {}
