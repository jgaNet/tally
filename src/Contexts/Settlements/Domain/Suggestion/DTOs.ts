/** A member of a group and what it is owed (positive) or owes (negative) in it, whole units: the balances as Settlements reads them. */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/** One transfer of a suggestion: `from` pays `to` the amount, in whole units of the group's currency (request 11). */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}
