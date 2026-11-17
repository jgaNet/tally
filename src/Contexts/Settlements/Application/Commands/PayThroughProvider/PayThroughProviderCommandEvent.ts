import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of a payment through the provider: the group it is paid in (as the route names it), the payee, and how much. The
 * payer is the caller, not a field: the one who owes pays.
 */
export interface PayThroughProviderPayload {
  groupId: string;
  to: string;
  amount: number;
}

export class PayThroughProviderCommandEvent extends CommandEvent<PayThroughProviderPayload> {}
