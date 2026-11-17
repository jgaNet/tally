import { CommandEvent } from '@Architecture/Domain';

/**
 * The payee of a settlement paid through the provider asks to refund it, whole: the caller is the payee, and `settlementId` is the
 * settlement's id. The book decides whether it may be refunded; the money goes back only once the provider says so (request 15).
 */
export class RefundSettlementCommandEvent extends CommandEvent<{
  settlementId: string;
}> {}
