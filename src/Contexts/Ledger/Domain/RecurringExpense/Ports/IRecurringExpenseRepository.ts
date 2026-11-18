import { Id, IResult } from '@Architecture/Domain';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

export interface IRecurringExpenseRepository {
  /** The recurring expense of this id as it was read (its version), or null when it does not exist or was stopped or ended. */
  findById(id: Id): Promise<RecurringExpense | null>;
  /** The ids of the recurring expenses whose next day has come (is on or before `day`), in the order they were set up. */
  dueBy(day: string): Promise<string[]>;
  /** Stores the recurring expense at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(recurring: RecurringExpense): Promise<IResult>;
}
