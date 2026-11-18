import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of a payment through the provider: the group it is paid in (as the route names it), the payee, and how much, in the
 * group's currency (`amount`), or in another one (`original`, request 39): exactly one of them is given. The payer is the caller,
 * not a field: the one who owes pays.
 */
export interface PayThroughProviderPayload {
  groupId: string;
  to: string;
  amount: number | null;
  original: { currency: string; amount: number } | null;
}

export class PayThroughProviderCommandEvent extends CommandEvent<PayThroughProviderPayload> {}
