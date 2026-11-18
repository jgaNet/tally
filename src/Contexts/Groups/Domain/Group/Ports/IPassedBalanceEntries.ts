/**
 * A balance that passed to the owner when a member left, as Groups recorded it: the key it was born with (`<group>:<position>`,
 * which a merge keeps, request 31), who left, and the balance.
 */
export interface PassedBalanceEntry {
  key: string;
  by: string;
  amount: number;
  at: string;
}

/** Groups' read of the balances that passed, for the group's audit Ledger keeps (PassedBalances, request 28). */
export interface IPassedBalanceEntries {
  entriesOf(groupId: string): Promise<PassedBalanceEntry[]>;
}
