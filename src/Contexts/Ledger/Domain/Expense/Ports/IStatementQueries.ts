/**
 * One expense a member paid or is in the split of, as the statement counts it: what the member paid for it (its amount
 * when they are its payer, 0 otherwise) and their share of it (0 when they are not in its split). `at` is when it was
 * recorded, which orders it among the settlements of its day (request 29).
 */
export interface ExpenseRow {
  kind: 'expense';
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  at: string;
}

/**
 * One settlement a member paid or received that the balances count, as the statement counts it (request 29): the member's
 * part of it, dated by the day the balances started to count it, and ordered by that instant (`at`).
 */
export interface SettlementRow {
  kind: 'settlement';
  settlementId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  at: string;
}

/** A row of a statement, before its balance is counted. */
export type StatementRow = ExpenseRow | SettlementRow;

/** One entry of a statement: the row's fields, and the member's balance once that entry is counted. */
export type StatementEntry =
  (Omit<ExpenseRow, 'at'> & { balance: number }) | (Omit<SettlementRow, 'at'> & { balance: number });

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
   * earliest recorded first. The settlements are not here: Ledger reads them through its port. The running balance is not
   * kept here: the handler counts it at the read.
   */
  expenseRowsOf(groupId: string, memberId: string): Promise<ExpenseRow[]>;
}
