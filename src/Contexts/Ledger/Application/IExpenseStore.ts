import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Share } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a screen shows of one expense: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface ExpenseView {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  readonly shares: readonly Share[];
}

/** What a member of a group is owed (positive) or owes (negative), in the group's currency's hundredths. */
export interface MemberBalanceView {
  readonly memberId: string;
  readonly balance: number;
}

/**
 * The store of expenses, the port the use cases write and read through. `add` keeps a new expense with its shares, and the
 * balances it counts, in the transaction of the command; `viewOf` answers an expense as a read model, or `undefined` when
 * there is none; `balancesOf` answers each member the group's expenses have counted, as the sum of what they paid less their
 * shares, in no particular order: a member nothing has counted is absent (the query gives such a member 0), and the order of
 * the members is the query's to give, never the store's. Nothing changes an expense once it is kept, so the store has no `save`.
 */
export interface IExpenseStore {
  add(expense: Expense): Promise<void>;
  viewOf(expenseId: string): Promise<ExpenseView | undefined>;
  balancesOf(groupId: string): Promise<MemberBalanceView[]>;
}
