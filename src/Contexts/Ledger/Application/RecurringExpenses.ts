import { Clock, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { callerOf, command, query, UseCase } from '@Architecture/Application/Lite/UseCase';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';

import { dayOf } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseView } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';
import { IRecurringExpenses } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenses';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/** What a member asks to set up: the expense they pay every month, as they give it (request 23). */
export interface SetUpRecurringExpenseInput {
  groupId: string;
  description: string;
  amount: number;
  startsOn: string;
  split: SplitInput;
}

/**
 * Sets up a recurring expense the caller pays every month (request 23, docs/adr/0022). The caller is its payer and must be a member
 * of the group: for anyone else the group does not exist. The split is checked as an expense's is, against the group's members.
 * Its id is the answer.
 */
export const setUpRecurringExpense = command(
  'SetUpRecurringExpense',
  (recurring: IRecurringExpenses, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, description, amount, startsOn, split }: SetUpRecurringExpenseInput, context) => {
      const paidBy = callerOf(context);
      const members = await groupMembers.membersOf(paidBy, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));

      const set = RecurringExpense.setUp({
        groupId,
        paidBy,
        description,
        amount,
        startsOn,
        split,
        members: members.map(member => member.memberId),
        at: clock(),
      });
      if (set.isFailure()) return set;

      const saved = await recurring.save(set.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(set.data, context);
      return Result.ok(set.data.id);
    },
);

/** What a member asks to stop: the recurring expense. */
export interface StopRecurringExpenseInput {
  id: string;
}

/**
 * Stops a recurring expense, for its payer or the group's owner (request 23, docs/adr/0022): it no longer exists, and no expense is
 * recorded for it from then on. The expenses it recorded stay. For anyone outside its group it does not exist.
 */
export const stopRecurringExpense = command(
  'StopRecurringExpense',
  (recurring: IRecurringExpenses, groupMembers: IGroupMembers) =>
    async ({ id }: StopRecurringExpenseInput, context) => {
      const by = callerOf(context);
      const stored = await recurring.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such recurring expense'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such recurring expense'));

      const stopped = stored.stop({ by, members });
      if (stopped.isFailure()) return stopped;
      const deleted = await recurring.delete(stopped.data);
      if (deleted.isFailure()) return deleted;
      await publishDomainEvents(stopped.data, context);
      return Result.ok(undefined);
    },
);

/** Reads a recurring expense, for the members of its group only: for anyone else it does not exist (request 23). */
export const getRecurringExpense = query(
  'GetRecurringExpense',
  (queries: IRecurringExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const found = await queries.findRecurring(id);
      if (!found) return Result.fail(new NotFoundException('Ledger', 'There is no such recurring expense'));
      const members = await groupMembers.membersOf(callerOf(context), found.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such recurring expense'));
      return Result.ok(found);
    },
);

/**
 * A group's recurring expenses, for its members only: each as `GetRecurringExpense` reads it, the earliest set up first (request 23).
 * For anyone else the group does not exist.
 */
export const getGroupRecurringExpenses = query(
  'GetGroupRecurringExpenses',
  (queries: IRecurringExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context): Promise<IResult<RecurringExpenseView[]>> => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      return Result.ok(await queries.listOf(groupId));
    },
);

/**
 * What one step of the background job did with a recurring expense on its day: `recorded` (the day's expense is to be recorded by
 * the reaction to its fact, and the next day is the job's to come to), `ended` (it no longer exists), or `idle` (its day has not come,
 * or it is gone).
 */
export type DayStep = 'idle' | 'recorded' | 'ended';

/**
 * One step of the background job on a recurring expense (request 23, docs/adr/0022), in its own transaction. Its day is asked
 * first: one that has not come is `idle` and reads nothing of the members. Otherwise the group's current members are asked, and the
 * recurring expense either moves on and records the day's fact, or ends. A recurring expense another server moved on first is read
 * again and decided again, so a day is recorded once whatever the servers.
 */
export const recordRecurringDay = command(
  'RecordRecurringDay',
  (recurring: IRecurringExpenses, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context): Promise<IResult<DayStep>> => {
      const stored = await recurring.get(id);
      const now = clock();
      if (!stored || !stored.isDue(now)) return Result.ok('idle');

      const run = stored.runDay(await groupMembers.currentMemberIds(stored.groupId));
      if (run.kind === 'ended') {
        const deleted = await recurring.delete(run.recurring);
        if (deleted.isFailure()) return deleted;
      } else {
        const saved = await recurring.save(run.recurring);
        if (saved.isFailure()) return saved;
      }
      await publishDomainEvents(run.recurring, context);
      return Result.ok(run.kind);
    },
);

/** What the background job reads and runs with: the recurring expenses due, and the step it takes for each (docs/adr/0022). */
export interface RecurringSweepPorts {
  queries: IRecurringExpenseQueries;
  recordDay: UseCase<{ id: string }, DayStep>;
  clock: Clock;
}

/**
 * One run of the background job for recurring expenses (request 23, docs/adr/0022): every recurring expense whose next day has come
 * is stepped on, each in its own transaction, until its next day is still to come or it has ended. A recurring expense whose first
 * day has passed records each day that has come, one at a time, at this run. A step that fails is logged, and the others go on.
 */
export async function sweepRecurringExpenses(
  { queries, recordDay, clock }: RecurringSweepPorts,
  context: ExecutionContext,
): Promise<void> {
  for (const id of await queries.dueOn(dayOf(clock()))) {
    for (;;) {
      const step: IResult<DayStep> = await recordDay.run({ id }, context);
      if (step.isFailure()) {
        context.logger?.error(`The background job could not step the recurring expense ${id}`, step.error);
        break;
      }
      if (step.data !== 'recorded') break;
    }
  }
}
