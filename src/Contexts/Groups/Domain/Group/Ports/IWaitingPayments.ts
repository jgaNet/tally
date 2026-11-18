/**
 * Groups' own port onto Settlements: whether a member has a payment waiting at the provider, one they pay or receive
 * through it, still pending or refunding, when they leave (request 20). Groups asks it when it decides, in its own
 * words; the adapter answers over Settlements' read model (ADR 11). No domain imports Settlements.
 */
export interface IWaitingPayments {
  /**
   * Whether a payment through the provider that this member pays or receives in the group has not ended: it is pending,
   * or refunding, until the provider says how it ended.
   */
  hasWaitingPaymentOf(groupId: string, memberId: string): Promise<boolean>;
  /** Whether any payment through the provider in the group is still pending or refunding: the group is archived only without one (request 27). */
  hasWaitingPaymentIn(groupId: string): Promise<boolean>;
}
