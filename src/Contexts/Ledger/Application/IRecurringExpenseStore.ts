import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/**
 * The split of a recurring expense as it was given (request 23): exactly one of the three ways, under the name the request gives it.
 * It is what a read shows, so the same shape the request's API names.
 */
export type RecurringSplitView =
  | { splitBetween: string[] }
  | { splitExactly: { memberId: string; amount: number }[] }
  | { splitByShares: { memberId: string; shares: number }[] };

/** What a screen shows of one recurring expense: a read model, never the aggregate (QUERY-READ-MODELS). */
export type RecurringExpenseView = {
  readonly id: string;
  readonly groupId: string;
  readonly paidBy: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly next: string;
} & RecurringSplitView;

/**
 * The store of recurring expenses, the port the use cases write and read through. `add` keeps a new one, in the command's transaction;
 * `findById` loads it as the aggregate it was last saved as, or `undefined`; `save` keeps it again, and `remove` takes it out, both only
 * while it is still at the version it was loaded at, and refuse it with a ConcurrencyConflictException otherwise (ADR 8); `viewOf`
 * answers one as a read model, or `undefined`; `listOf` answers a group's, the earliest set up first; `dueBy` answers those whose next day
 * is no later than the day given, for the background sweep (ADR 18).
 */
export interface IRecurringExpenseStore {
  add(recurring: RecurringExpense): Promise<void>;
  findById(recurringId: string): Promise<RecurringExpense | undefined>;
  save(recurring: RecurringExpense): Promise<void>;
  remove(recurring: RecurringExpense): Promise<void>;
  viewOf(recurringId: string): Promise<RecurringExpenseView | undefined>;
  listOf(groupId: string): Promise<RecurringExpenseView[]>;
  dueBy(day: string): Promise<RecurringExpense[]>;
}
