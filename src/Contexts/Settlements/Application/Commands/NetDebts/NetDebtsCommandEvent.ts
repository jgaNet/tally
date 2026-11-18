import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of a netting: the other person to net with, and the currency. The one who asks is the caller, not a field: the
 * netting is between the caller and `with`.
 */
export interface NetDebtsPayload {
  with: string;
  currency: string;
}

export class NetDebtsCommandEvent extends CommandEvent<NetDebtsPayload> {}
