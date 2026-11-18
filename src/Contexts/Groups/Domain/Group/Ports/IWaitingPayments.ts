import { Id } from '@Architecture/Domain';

/**
 * Groups' port to Settlements, which Groups owns (the storm's WaitingPayments, request 20): whether a payment the account pays or
 * receives in the group is waiting at the provider, pending or being refunded. A member with one may not leave: the payment would
 * change a balance once it lands. Answered by an adapter over Settlements' read model; read by the command deciding the leave,
 * inside its own transaction, so it takes no lock.
 */
export interface IWaitingPayments {
  waitingOf(groupId: string, accountId: Id): Promise<boolean>;
  /** Whether any payment in the group is waiting at the provider, pending or being refunded: read when the group is archived (request 27). */
  waitingIn(groupId: string): Promise<boolean>;
  /** Whether any payment the account pays or receives, in any group, is waiting at the provider: pending, being refunded or contested. Read when the account is deleted (request 35). */
  waitingForAccount(accountId: Id): Promise<boolean>;
}
