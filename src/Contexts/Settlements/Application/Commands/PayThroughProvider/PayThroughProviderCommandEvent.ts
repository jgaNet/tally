import { CommandEvent } from '@Architecture/Domain';

/**
 * A member who owes another member of the group asks to pay them through the provider: the caller is the payer, and `to` is the
 * payee's account id. The amount is a whole number, at least 1, decided by the book, never more than is still owed.
 */
export class PayThroughProviderCommandEvent extends CommandEvent<{
  groupId: string;
  to: string;
  amount: number;
}> {}
