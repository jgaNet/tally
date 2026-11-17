/** One member's balance in a group as a member reads it: positive when the group owes them, negative when they owe it. */
export interface MemberBalanceReadModel {
  memberId: string;
  balance: number;
}
