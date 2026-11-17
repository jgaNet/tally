/** What a member of a group still owes, as Settlements answers it (request 18, docs/adr/0018): `amount` is positive. */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  amount: number;
}

/** A debt the sweep has noted or reminded of: the member and the group. */
export interface DebtKey {
  accountId: string;
  groupId: string;
}
