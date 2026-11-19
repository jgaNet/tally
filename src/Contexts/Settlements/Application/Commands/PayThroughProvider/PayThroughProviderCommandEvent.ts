import { CommandEvent } from '@Architecture/Domain';

import { MoneyPayload } from '@Contexts/Settlements/Application/Commands/PaidIn';

/**
 * A member who owes another member of the group asks to pay them through the provider: the caller is the payer, and `to` is the
 * payee's account id. The money is an amount in the group's currency, or what is paid in another currency (request 39): exactly one, as
 * the transport gives it. The amount is a whole number, at least 1, decided by the book, never more than is still owed.
 */
export class PayThroughProviderCommandEvent extends CommandEvent<{
  groupId: string;
  to: string;
  money: MoneyPayload;
}> {}
