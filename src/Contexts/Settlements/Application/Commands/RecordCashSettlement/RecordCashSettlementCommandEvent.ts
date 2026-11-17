import { CommandEvent } from '@Architecture/Domain';

/**
 * A member records a payment in cash they received from another member of the group: the caller is the payee, and `from` is
 * the payer's account id. The amount is a whole number, at least 1, checked by the book, never more than is owed.
 */
export class RecordCashSettlementCommandEvent extends CommandEvent<{
  groupId: string;
  from: string;
  amount: number;
}> {}
