/**
 * The payments waiting at the provider, as Settlements' read model gives them to the other contexts (request 20, ADR 15): a port
 * Settlements owns the read of, answered over its own table. A payment waits while it is `pending` (the provider has not said it
 * succeeded), `refunding` (Tally has asked for the money back and the provider has not said so yet) or `contested` (feature 33), and is
 * paid through the provider. `hasWaitingPayment` says whether the member pays or receives one of them in the group; `hasPaymentWaitingOf`
 * says whether the account pays or receives one of them in any group (feature 35: a deletion waits for none).
 */
export interface IWaitingPaymentRoster {
  hasWaitingPayment(groupId: string, memberId: string): Promise<boolean>;
  hasPaymentWaitingOf(accountId: string): Promise<boolean>;
}
