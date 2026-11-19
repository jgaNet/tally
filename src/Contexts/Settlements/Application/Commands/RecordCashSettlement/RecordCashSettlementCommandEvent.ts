import { CommandEvent } from '@Architecture/Domain';

import { MoneyPayload } from '@Contexts/Settlements/Application/Commands/PaidIn';

/**
 * A member records a payment in cash they received from another member of the group: the caller is the payee, and `from` is
 * the payer's account id. The money is an amount in the group's currency, or what was paid in another currency (request 39): exactly
 * one, as the transport gives it. The amount is a whole number, at least 1, checked by the book, never more than is owed.
 */
export class RecordCashSettlementCommandEvent extends CommandEvent<{
  groupId: string;
  from: string;
  money: MoneyPayload;
}> {}
