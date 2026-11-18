/** One entry of a member's statement of an expense (request 8): what the member paid for it, their share of it, and their balance after it. */
export interface ExpenseEntryView {
  kind: 'expense';
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
}

/**
 * One entry of a member's statement of a settlement the balances count (request 29): what the member paid (the payer's amount) or was paid
 * (the payee's amount) by it, and their balance once it is counted.
 */
export interface SettlementEntryView {
  kind: 'settlement';
  settlementId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
}

/** One entry of a member's statement, as `GetMemberStatement` answers it: an expense's, or a settlement's (request 29). */
export type StatementEntryView = ExpenseEntryView | SettlementEntryView;

/** What `GetMemberStatement` and `GetMemberStatementCsv` answer: a member's entries in the order of a bank statement, and their balance (the last entry's, or 0). */
export interface StatementView {
  memberId: string;
  balance: number;
  entries: StatementEntryView[];
}

/**
 * The statement of a member of a group, the read model of a member's statement (request 8, request 29), which Ledger answers from its own
 * expenses and the settlements the balances count. A port Ledger owns, answered by an adapter in its Infrastructure; the query never sorts.
 */
export interface IStatementQueries {
  /**
   * The statement of the member: every expense not deleted that the member paid or is in the split of, and every settlement the balances
   * count in which the member is the payer or the payee, in the order of a bank statement: the earliest date first and, on the same date, an
   * expense by when it was recorded and a settlement by when the balances started to count it (on the same instant, the expense first). The
   * balance of each entry is the member's running balance once it is counted; the statement's is the last entry's, or 0. A member with no
   * entries has an empty statement at 0.
   */
  statementOf(groupId: string, memberId: string): Promise<StatementView>;
}
