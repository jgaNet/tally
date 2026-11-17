import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

export interface IExpenseQueries {
  /** The expense under this id, whoever asks: the handler decides whether the caller may read it. */
  findById(id: string): Promise<ExpenseReadModel | null>;
  /**
   * Every expense of the group that has not been deleted, in the order they were recorded, the earliest first: an edit does
   * not move one. Whoever asks: the handler decides whether the caller may read them, and sorts them as its query says.
   */
  ofGroup(groupId: string): Promise<ExpenseReadModel[]>;
}
