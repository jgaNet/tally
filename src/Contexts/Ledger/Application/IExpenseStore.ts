import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { OriginalRecord } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { Share, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a screen shows of one expense: a read model, never the aggregate (QUERY-READ-MODELS). Its version is the one it is at. */
export interface ExpenseView {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  readonly splitKind: SplitKind;
  readonly shares: readonly Share[];
  readonly version: number;
  /** What it was paid in, when it was paid in another currency (request 21): its currency, amount and rate, as given. */
  readonly original?: OriginalRecord;
}

/** What a member of a group is owed (positive) or owes (negative), in the group's currency's hundredths. */
export interface MemberBalanceView {
  readonly memberId: string;
  readonly balance: number;
}

/**
 * One line of a member's statement as the store reads it: an expense of the group the member paid or is in the split of, what
 * the member paid for it (its amount when they paid it, 0 otherwise) and their share of it (0 when they are not in its split).
 * The balance after each line is the query's to count, in the statement's order (request 8), never the store's.
 */
export interface StatementRowView {
  readonly expenseId: string;
  readonly date: string;
  readonly description: string;
  readonly paid: number;
  readonly share: number;
}

/**
 * The store of expenses, the port the use cases write and read through. `add` keeps a new expense with its shares, and the
 * balances it counts, in the transaction of the command; `findById` loads an expense as the aggregate it was last saved as,
 * or `undefined` when there is none; `save` keeps an edited expense, and `remove` takes a deleted one out, both only while it
 * is still at the version it was loaded at, and refuse it with a ConcurrencyConflictException otherwise (ADR 8); `viewOf`
 * answers an expense as a read model, or `undefined` when there is none; `balancesOf` answers each member the group's expenses
 * have counted, as the sum of what they paid less their shares, in no particular order: a member nothing has counted is absent
 * (the query gives such a member 0), and the order of the members is the query's to give, never the store's. `listOf` answers
 * the group's expenses that are not deleted, each as `viewOf` answers it, the latest date first and, on the same date, the most
 * recently recorded first (the store's order is the list's: it is read from the recording, which no edit changes).
 * `statementRowsOf` answers a member's statement lines of a group, the earliest date first and, on the same date, the earliest
 * recorded first: the expenses that are not deleted and that the member paid or is in the split of.
 */
export interface IExpenseStore {
  add(expense: Expense): Promise<void>;
  findById(expenseId: string): Promise<Expense | undefined>;
  save(expense: Expense): Promise<void>;
  remove(expense: Expense): Promise<void>;
  viewOf(expenseId: string): Promise<ExpenseView | undefined>;
  listOf(groupId: string): Promise<ExpenseView[]>;
  statementRowsOf(groupId: string, memberId: string): Promise<StatementRowView[]>;
  balancesOf(groupId: string): Promise<MemberBalanceView[]>;
}
