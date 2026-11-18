import { RecurringExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringExpenseReadModel';

export interface IRecurringExpenseQueries {
  /** The recurring expense under this id, whoever asks: the handler decides whether the caller may read it. */
  findById(id: string): Promise<RecurringExpenseReadModel | null>;
  /** Every recurring expense of the group, the earliest set up first. Whoever asks: the handler decides whether the caller may read them. */
  ofGroup(groupId: string): Promise<RecurringExpenseReadModel[]>;
}
