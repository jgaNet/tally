import { Id, IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

export interface IExpenseRepository {
  /** The expense under this id, or null. */
  findById(id: Id): Promise<Expense | null>;
  /** Stores a new expense under the id it was born with. It runs in the command's transaction. */
  save(expense: Expense): Promise<IResult>;
}
