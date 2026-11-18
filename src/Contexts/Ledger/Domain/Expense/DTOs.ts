import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A member's share of an expense: whole units of the group's currency, the shares of a split adding up to its amount. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/** How an expense is split (request 7): equally, by exact amounts, or by whole shares. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/**
 * What an expense was paid in, when that was not the group's currency (request 21): the currency, the amount in its hundredths and the
 * rate as the payer gave it, the string. The expense's `amount` is the group's, computed from these (docs/adr/0020).
 */
export interface OriginalAmountSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

/** The state of an expense as the store keeps it: what `Expense.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  /** A day of the calendar, `YYYY-MM-DD`. */
  date: string;
  paidBy: string;
  /** How the split was given: the shares are that split's, the kind says how they were made. */
  splitKind: SplitKind;
  /** The shares, in the order the split was given. */
  shares: ShareSnapshot[];
  /** What it was paid in, when not in the group's currency; absent for an expense in the group's currency. */
  original?: OriginalAmountSnapshot;
  /** What the expense is for (request 24): one of the categories, `other` when none was given. */
  category: Category;
  /** The version the expense was read at: the store stores version + 1 on every save. */
  version: number;
}

/** What a member reads of an expense: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  /** How the expense is split: `equal`, `exact` or `shares` (request 7). The expenses recorded before it are `equal`. */
  splitKind: SplitKind;
  shares: ShareSnapshot[];
  /** What it was paid in, when not in the group's currency (request 21): absent for an expense in the group's currency. */
  original?: OriginalAmountSnapshot;
  /** What the expense is for (request 24): one of the categories, `other` for the expenses recorded before them. */
  category: Category;
  /** The version the expense is at: 1 when it is recorded, one more at each edit (request 6). */
  version: number;
}

/**
 * The rate offered for a currency to the group's on a day (request 22, docs/adr/0021): what one unit of `currency` is worth in the
 * group's currency on `date`, as the rates service gives it, the string. A read model of the offer, never kept.
 */
export interface RateView {
  currency: string;
  date: string;
  rate: string;
}

/** What a member is owed (positive) or owes (negative) in a group, whole units: a read model (docs/adr/0005). */
export interface BalanceView {
  memberId: string;
  balance: number;
}

/**
 * A line of a member's statement (request 8, docs/adr/0008): an expense the member paid or is in the split of, what they paid
 * for it (0 unless they are its payer), their share of it (0 unless they are in its split), and their balance once it is counted.
 */
export interface StatementEntryView {
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
}

/** A member's statement in a group: its entries in the order of a bank statement, and the balance the group's balances give. */
export interface StatementView {
  memberId: string;
  balance: number;
  entries: StatementEntryView[];
}
