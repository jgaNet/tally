import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

export interface IExpenseQueries {
  /** The expense under this id, whoever asks: the handler decides whether the caller may read it. */
  findById(id: string): Promise<ExpenseReadModel | null>;
}
