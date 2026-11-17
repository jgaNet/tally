import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

export interface IExpenseQueries {
  /** The expense of this id as it was recorded, its shares in the order of the split; null when there is none. */
  findById(id: string): Promise<ExpenseReadModel | null>;
}
