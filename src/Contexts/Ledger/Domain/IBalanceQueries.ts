/**
 * The read side of the balances: what each member of a group owes or is owed, read from the expenses (ADR 1, T4). A read
 * model, never an aggregate (QUERY-READ-MODELS). Groups reads it through its own `MemberBalances` port, answered by its adapter
 * (feature 9, ADR 7); Ledger's read side `IExpenseQueries` extends it.
 */
export interface IBalanceQueries {
  /**
   * The balance of every member the group's expenses have counted, in no order. A member not in the map has 0. The
   * whole map is read in one statement, so it is one state of the group, never half of an expense.
   */
  balancesOf(groupId: string): Promise<ReadonlyMap<string, number>>;
}
