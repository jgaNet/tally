import { CommandEvent } from '@Architecture/Domain';

/** A payee records a payment in cash that a member of the group made them: the group, the payer's account id, and the amount. */
export class RecordCashSettlementCommandEvent extends CommandEvent<{ groupId: string; from: string; amount: number }> {}
