/**
 * One expense a member paid or is in the split of, as the statement counts it: what the member paid for it (its amount
 * when they are its payer, 0 otherwise) and their share of it (0 when they are not in its split).
 */
export interface StatementRow {
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
}

/** One entry of a statement: the row, and the member's balance once that entry is counted. */
export interface StatementEntry extends StatementRow {
  balance: number;
}

/** A member's statement in a group: the entries in order, and the balance the last entry leaves (0 with none). */
export interface MemberStatement {
  memberId: string;
  balance: number;
  entries: StatementEntry[];
}

/** The read side of statements: a read model of Ledger's own expenses, never an aggregate (QUERY-READ-MODELS). */
export interface IStatementQueries {
  /**
   * The expenses of the group, not deleted, that the member paid or is in the split of, the earliest date first, then the
   * earliest recorded first. The running balance is not kept here: the handler counts it at the read.
   */
  rowsOf(groupId: string, memberId: string): Promise<StatementRow[]>;
}
