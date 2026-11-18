import { RecurringReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringReadModel';

export interface IRecurringExpenseQueries {
  /** The recurring expense of this id as it reads, or null when there is none (stopped and ended ones are gone). */
  findById(id: string): Promise<RecurringReadModel | null>;
  /** The recurring expenses of a group, the earliest set up first. Empty for a group with none, or that does not exist. */
  listByGroup(groupId: string): Promise<RecurringReadModel[]>;
}
