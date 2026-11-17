/** One member's balance in a group: what they paid for its expenses minus their shares; positive when the group owes them. */
export interface BalanceReadModel {
  memberId: string;
  balance: number;
}
