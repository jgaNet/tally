/** One expense a member's statement lists: what the member paid for it, their share of it, and their balance once it is counted. */
export interface ExpenseEntryReadModel {
  kind: 'expense';
  expenseId: string;
  date: string;
  description: string;
  /** What the member paid for it: its amount when they are its payer, 0 otherwise. */
  paid: number;
  /** The member's share of it: 0 when they are not in its split. */
  share: number;
  /** The member's balance once this entry is counted, from 0 at the start of the statement. */
  balance: number;
}

/**
 * One settlement a member's statement lists (request 29): what the member paid in it (its amount, as payer) or received (as
 * payee, shown as their share, so the balance goes down), and the balance once it is counted.
 */
export interface SettlementEntryReadModel {
  kind: 'settlement';
  settlementId: string;
  /** The day, in UTC, the balances started to count it. */
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
}

/** An entry of a member's statement: an expense or a settlement, in the order of the statement. */
export type StatementEntryReadModel = ExpenseEntryReadModel | SettlementEntryReadModel;

/** A member's statement in a group: the entries in the order of a bank statement, and the balance the last one leaves (0 when there are none). */
export interface StatementReadModel {
  memberId: string;
  balance: number;
  entries: StatementEntryReadModel[];
}

/**
 * An expense of a member's statement before the balance is counted, with `at`: when it was recorded, which orders it within its
 * date. Not part of the read model; the handler drops it.
 */
export type ExpenseLine = Omit<ExpenseEntryReadModel, 'balance'> & { at: string };

/** A settlement of a member's statement before the balance is counted, with `at`: when the balances started to count it. */
export type SettlementLine = Omit<SettlementEntryReadModel, 'balance'> & { at: string };

/** A line of a member's statement before the balance is counted. */
export type StatementLine = ExpenseLine | SettlementLine;
