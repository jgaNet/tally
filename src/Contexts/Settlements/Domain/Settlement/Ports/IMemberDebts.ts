/** What one current member of a group still owes in it, as a positive amount: the member and the group it is owed in. */
export interface MemberDebt {
  groupId: string;
  memberId: string;
  owed: number;
}

/**
 * Who still owes what, in every group, read from Settlements' own record and Ledger's balances (ADR 12): a member's balance
 * with the payments waiting at the provider counted as paid, the same reading the suggested settlements make of it. Only
 * the current members of a group are in it, and only those who owe something (a member not in it owes 0). Settlements owns
 * the answer; Notifications asks it through its own port (OutstandingDebts) and its adapter reads this one.
 */
export interface IMemberDebts {
  owedByMember(): Promise<MemberDebt[]>;
}
