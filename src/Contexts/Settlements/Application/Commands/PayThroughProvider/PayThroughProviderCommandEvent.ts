import { CommandEvent } from '@Architecture/Domain';

/**
 * A member asks to pay another member of the group through the provider: the group, the payee's account id, and either the amount,
 * in the group's currency, or what is paid in another currency (request 39).
 */
export class PayThroughProviderCommandEvent extends CommandEvent<{
  groupId: string;
  to: string;
  amount?: number;
  original?: { currency: string; amount: number };
}> {}
