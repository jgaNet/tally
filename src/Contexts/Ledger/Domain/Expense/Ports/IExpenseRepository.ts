import { Id, IResult } from '@Architecture/Domain';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

export interface IExpenseRepository {
  /** The expense of this id as it was read (its version), or null. */
  findById(id: Id): Promise<Expense | null>;
  /** The ids of the expenses of a group, in the order they were recorded: what a merge moves (request 31). */
  idsInGroup(groupId: Id): Promise<Id[]>;
  /**
   * Stores the expense at version + 1, or, for an expense a merge moved, its new group at the same version (request 31); refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(expense: Expense): Promise<IResult>;
}
