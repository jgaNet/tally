import { CommandEvent } from '@Architecture/Domain';

/**
 * A signed-in member nets what the caller and `with` owe each other, across every group they share now, in `currency`, not archived
 * (request 32). The caller is one of the two; the operation answers the netting's id. Refused when it is with oneself, in a currency
 * Tally does not keep, or when there is nothing to net.
 */
export class NetDebtsCommandEvent extends CommandEvent<{
  with: string;
  currency: string;
}> {}
