export interface IBalanceQueries {
  /**
   * The balance of each member of the group who has an entry in one of its expenses, as a map from member id to balance.
   * It holds no order and no entry for a member with nothing recorded (the query answers those 0). Read in one statement,
   * so it never sees an expense half-written: each expense's entries are written with the expense.
   */
  sumsByMember(groupId: string): Promise<Map<string, number>>;
}
