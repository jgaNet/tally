/** A balance that passed to the owner when a member left, as Groups recorded it: its position in the group, who left, and the balance. */
export interface PassedBalanceEntry {
  position: number;
  by: string;
  amount: number;
  at: string;
}

/** Groups' read of the balances that passed, for the group's audit Ledger keeps (PassedBalances, request 28). */
export interface IPassedBalanceEntries {
  entriesOf(groupId: string): Promise<PassedBalanceEntry[]>;
}
