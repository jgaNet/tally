import { RecurringExpenseView } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';

/** The read side of the recurring expenses: what the queries and the background job read, at once (docs/adr/0022). */
export interface IRecurringExpenseQueries {
  /** The recurring expense, or undefined when there is no such one. */
  findRecurring(recurringId: string): Promise<RecurringExpenseView | undefined>;
  /** The group's recurring expenses, the earliest set up first (request 23). */
  listOf(groupId: string): Promise<RecurringExpenseView[]>;
  /** The ids of the recurring expenses whose next day is not after `day`, the earliest set up first: the background job's work. */
  dueOn(day: string): Promise<string[]>;
}
