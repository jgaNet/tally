import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

export interface IExpenseQueries {
  /** The expense of this id as it was recorded, its shares in the order of the split; null when there is none. */
  findById(id: string): Promise<ExpenseReadModel | null>;
  /**
   * The expenses of a group that are not deleted, each as `findById` reads it, the latest date first and, on the same
   * date, the most recently recorded first (an edit does not change when an expense was recorded). Empty for a group
   * with none, or that does not exist.
   */
  listByGroup(groupId: string): Promise<ExpenseReadModel[]>;
}
