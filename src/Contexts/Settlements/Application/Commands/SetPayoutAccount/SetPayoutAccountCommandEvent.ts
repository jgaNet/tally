import { CommandEvent } from '@Architecture/Domain';

/** A member's payout account (request 16): the provider's id of the account the member is paid on. The member is the caller, not a field. */
export interface SetPayoutAccountPayload {
  accountId: string;
}

export class SetPayoutAccountCommandEvent extends CommandEvent<SetPayoutAccountPayload> {}
