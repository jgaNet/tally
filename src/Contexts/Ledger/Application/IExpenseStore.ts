import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
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
}

/** What a member of a group is owed (positive) or owes (negative), in the group's currency's hundredths. */
export interface MemberBalanceView {
  readonly memberId: string;
  readonly balance: number;
}

/**
 * The store of expenses, the port the use cases write and read through. `add` keeps a new expense with its shares, and the
 * balances it counts, in the transaction of the command; `findById` loads an expense as the aggregate it was last saved as,
 * or `undefined` when there is none; `save` keeps an edited expense, and `remove` takes a deleted one out, both only while it
 * is still at the version it was loaded at, and refuse it with a ConcurrencyConflictException otherwise (ADR 8); `viewOf`
 * answers an expense as a read model, or `undefined` when there is none; `balancesOf` answers each member the group's expenses
 * have counted, as the sum of what they paid less their shares, in no particular order: a member nothing has counted is absent
 * (the query gives such a member 0), and the order of the members is the query's to give, never the store's.
 */
export interface IExpenseStore {
  add(expense: Expense): Promise<void>;
  findById(expenseId: string): Promise<Expense | undefined>;
  save(expense: Expense): Promise<void>;
  remove(expense: Expense): Promise<void>;
  viewOf(expenseId: string): Promise<ExpenseView | undefined>;
  balancesOf(groupId: string): Promise<MemberBalanceView[]>;
}
