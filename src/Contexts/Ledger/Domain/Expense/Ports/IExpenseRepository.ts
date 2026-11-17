import { Id, IResult } from '@Architecture/Domain';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

export interface IExpenseRepository {
  /** The expense of this id as it was read (its version), or null. */
  findById(id: Id): Promise<Expense | null>;
  /** Stores the expense at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(expense: Expense): Promise<IResult>;
}
