import { CommandEvent } from '@Architecture/Domain';

/** A payee asks to refund a settlement paid through the provider, whole: the settlement's id. */
export class RefundSettlementCommandEvent extends CommandEvent<{ settlementId: string }> {}
