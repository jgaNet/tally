/**
 * The read-model port another context reads the payments waiting at the provider through (request 20): whether a payment the member
 * pays or receives in the group is pending, or being refunded, so that the member may not leave the group yet. Read by the command
 * deciding the leave, inside its own transaction, so it takes no lock.
 */
export interface IWaitingPaymentsQueries {
  isWaitingFor(groupId: string, memberId: string): Promise<boolean>;
  /** Whether any payment in the group is pending, or being refunded, at the provider: read when the group is archived (request 27). */
  isWaitingIn(groupId: string): Promise<boolean>;
  /** Whether any payment the account pays or receives, in any group, is pending, being refunded or contested: read when the account is deleted (request 35). */
  isWaitingForAccount(accountId: string): Promise<boolean>;
}
