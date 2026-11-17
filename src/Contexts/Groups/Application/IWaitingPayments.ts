/**
 * Whether a member of a group has a payment through the provider waiting, pending or being refunded, as Groups needs it before the member
 * leaves (request 20): a port Groups owns, in its own words, answered by an adapter over Settlements' read model
 * (`WaitingPaymentsOfSettlements`, in this context's Infrastructure). Settlements' Domain is never imported.
 */
export interface IWaitingPayments {
  waitingOf(groupId: string, memberId: string): Promise<boolean>;
}
