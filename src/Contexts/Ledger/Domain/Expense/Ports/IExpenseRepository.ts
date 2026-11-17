import { IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** The store of expenses: saves whole aggregates, inside a transaction only (docs/adr/0004). */
export interface IExpenseRepository {
  /** Stores a new expense, with the shares it was decided with. */
  save(expense: Expense): Promise<IResult<undefined>>;
}
