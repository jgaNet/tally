/** What has been settled for one member of a group: the change the group's settlements make to the member's balance. */
export interface SettledAmountOf {
  memberId: string;
  /** Positive for a payer (their balance goes up by what they paid), negative for a payee (it goes down). */
  amount: number;
}

/**
 * The read-model port another context reads what has been settled through (ADR 7): one row per member with a settlement in
 * the group, the sum of the settlements' effect on their balance. Read by Ledger when it reads a balance, inside the command's
 * transaction or outside it, so it takes no lock of its own.
 */
export interface ISettledAmountsQueries {
  settledOf(groupId: string): Promise<SettledAmountOf[]>;
}
