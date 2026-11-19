/**
 * Whether a member may leave a group, as Groups needs it to decide a leave (conventions/domain.yaml, the Settlements → Groups link;
 * request 20, docs/adr/0019): a payment the member makes or receives through the provider, in the group, is pending or refunding.
 * Groups owns the port, in its own words; Settlements answers it through an adapter in Groups' Infrastructure, over Settlements' read
 * model. It is asked when a leave is decided, inside its transaction.
 */
export interface IWaitingPayments {
  /** Whether a payment of the account, in the group, waits at the provider: pending or refunding (requests 13, 15). */
  paymentWaitingOf(groupId: string, accountId: string): Promise<boolean>;
  /**
   * Whether a payment of the account waits at the provider in any group: pending, refunding or contested (requests 13, 15, 33). An account
   * is deleted only when none does (request 35, docs/adr/0035).
   */
  paymentWaitingOfAccount(accountId: string): Promise<boolean>;
}
