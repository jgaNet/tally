/**
 * Whether a payment of this account waits at the payment provider in this group (request 20, ADR 13): a settlement it pays or
 * receives through the provider that is pending or refunding. Groups owns the port, in its own words; its adapter answers it
 * over Settlements' read side. A member with such a payment cannot leave until it has ended.
 */
export interface IWaitingPayments {
  hasWaitingPayments(groupId: string, accountId: string): Promise<boolean>;
}
