import { CommandEvent } from '@Architecture/Domain';

/**
 * A payee records a payment in cash that a member of the group made them: the group, the payer's account id, and either the amount,
 * in the group's currency, or what was paid in another currency (request 39). Its shape is the transport's to check.
 */
export class RecordCashSettlementCommandEvent extends CommandEvent<{
  groupId: string;
  from: string;
  amount?: number;
  original?: { currency: string; amount: number };
}> {}
