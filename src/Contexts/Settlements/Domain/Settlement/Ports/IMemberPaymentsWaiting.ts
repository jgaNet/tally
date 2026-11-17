/**
 * Whether a member has a payment waiting at the provider in a group (request 20, ADR 13): a settlement it pays or receives
 * through the provider that is pending or refunding, that is, not yet ended. Settlements owns the answer; Groups asks it
 * through its own port (WaitingPayments) when a member leaves, and its adapter reads this one.
 */
export interface IMemberPaymentsWaiting {
  hasWaitingPayment(groupId: string, memberId: string): Promise<boolean>;
}
