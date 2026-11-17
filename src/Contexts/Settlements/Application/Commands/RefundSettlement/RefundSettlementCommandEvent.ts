import { CommandEvent } from '@Architecture/Domain';

/**
 * A refund of a settlement paid through the provider (request 15): the settlement, named as the route names it. The member who
 * asks is the caller, not a field: only the payee may refund it.
 */
export interface RefundSettlementPayload {
  settlementId: string;
}

export class RefundSettlementCommandEvent extends CommandEvent<RefundSettlementPayload> {}
