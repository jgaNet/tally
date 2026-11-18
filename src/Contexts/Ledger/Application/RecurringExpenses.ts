import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { IRecurringExpenseStore, RecurringExpenseView } from '@Contexts/Ledger/Application/IRecurringExpenseStore';
import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { GroupNotFoundException, NotThePayerOrOwnerException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpense, dayOf } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { RecurringExpenseNotFoundException } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';

/** What a member asks to set up: the group it is in and the rest of the request; the payer is the caller. */
export interface SetUpRecurringExpenseInput {
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly split: SplitDraft;
  /** What each expense it records is spent on (request 24): one of the eight, `other` when left out. */
  readonly category?: string;
}

/**
 * Sets up a recurring expense the signed-in person pays every month (request 23): its payer is the caller, and the group is read
 * through the owned port. A caller who is not a member of the group gets the group's `404`. Answers the new recurring expense's id;
 * what it recorded (RecurringExpenseSetUp) goes out with the commit, through the outbox.
 */
export const setUpRecurringExpense = command(
  'SetUpRecurringExpense',
  (recurring: IRecurringExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, ...draft }: SetUpRecurringExpenseInput, context): Promise<IResult<string>> => {
      const payerId = callerOf(context);
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, payerId)) return Result.fail(new GroupNotFoundException());

      const set = RecurringExpense.setUp(
        { groupId, payerId, ...draft },
        members.map(member => member.memberId),
        clock(),
      );
      if (set.isFailure()) return Result.fail(set.error);

      await recurring.add(set.data);
      await publishDomainEvents(set.data, context);
      return Result.ok(set.data.toSnapshot().id);
    },
);

/**
 * Stops a recurring expense: no expense is recorded for it from now on, and the expenses it recorded stay (request 23). Only its payer
 * or the group's owner may (`403` to any other member); to someone outside the group it does not exist (`404`). What it recorded
 * (RecurringExpenseStopped) goes out with the commit.
 */
export const stopRecurringExpense = command(
  'StopRecurringExpense',
  (recurring: IRecurringExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async (recurringId: string, context): Promise<IResult<void>> => {
      const found = await changeable(recurring, groupMembers, recurringId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { recurring: stopped } = found.data;

      stopped.stop(clock());
      await recurring.remove(stopped);
      await publishDomainEvents(stopped, context);
      return Result.ok(undefined);
    },
);

/**
 * A recurring expense as a member of its group reads it: its payer, description, amount, `startsOn`, the split as it was given and `next`.
 * To anyone else it does not exist: the same `404` for one that does not exist and one of a group the caller is not in.
 */
export const getRecurringExpense = query(
  'GetRecurringExpense',
  (recurring: IRecurringExpenseStore, groupMembers: IGroupMembers) =>
    async (recurringId: string, context): Promise<IResult<RecurringExpenseView>> => {
      const view = await recurring.viewOf(recurringId);
      if (!view) return Result.fail(new RecurringExpenseNotFoundException());

      const members = await groupMembers.membersOf(view.groupId);
      if (!members || !isMember(members, callerOf(context)))
        return Result.fail(new RecurringExpenseNotFoundException());
      return Result.ok(view);
    },
);

/**
 * The recurring expenses of a group, the earliest set up first, as a member of the group reads them. A caller who is not a member gets
 * the group's `404`.
 */
export const getGroupRecurringExpenses = query(
  'GetGroupRecurringExpenses',
  (recurring: IRecurringExpenseStore, groupMembers: IGroupMembers) =>
    async (groupId: string, context): Promise<IResult<RecurringExpenseView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, callerOf(context))) return Result.fail(new GroupNotFoundException());
      return Result.ok(await recurring.listOf(groupId));
    },
);

/**
 * The background sweep (request 23, ADR 18): each recurring expense whose next day has come is looked at once per run, which the
 * composition root starts every JOBS_INTERVAL_SECONDS with the one clock. Its group's current members are asked (GroupMembers); the
 * aggregate decides: a recurring expense whose payer or a split member has left ends, and is removed; any other records the days that
 * have come, each for its expense, and is saved over the version it was read at. Nothing is decided by a read. A conflict with another
 * server's run runs the whole sweep again on what that run committed (CONFLICT_ATTEMPTS). Its facts go out with the commit, and the
 * expense each day records is made by the reaction to its fact.
 */
export const sweepRecurringExpenses = command(
  'SweepRecurringExpenses',
  (recurring: IRecurringExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async (_: void, context): Promise<IResult<void>> => {
      const now = clock();
      for (const item of await recurring.dueBy(dayOf(now))) {
        const members = await groupMembers.membersOf(item.groupId);
        const outcome = item.sweep(
          members?.map(member => member.memberId),
          now,
        );
        if (outcome === 'ended') await recurring.remove(item);
        else await recurring.save(item);
        await publishDomainEvents(item, context);
      }
      return Result.ok(undefined);
    },
);

/**
 * The recurring expense a caller may change, as the caller may see it: it is there for them (one of a group they are a member of, else
 * the same `404` as one that does not exist), and they are its payer or the group's owner (else `403`).
 */
async function changeable(
  recurring: IRecurringExpenseStore,
  groupMembers: IGroupMembers,
  recurringId: string,
  context: ExecutionContext,
): Promise<IResult<{ recurring: RecurringExpense }>> {
  const item = await recurring.findById(recurringId);
  if (!item) return Result.fail(new RecurringExpenseNotFoundException());

  const members = await groupMembers.membersOf(item.groupId);
  const caller = callerOf(context);
  const me = members?.find(member => member.memberId === caller);
  if (!members || !me) return Result.fail(new RecurringExpenseNotFoundException());
  if (item.toSnapshot().paidBy !== caller && me.role !== 'owner') return Result.fail(new NotThePayerOrOwnerException());
  return Result.ok({ recurring: item });
}

const isMember = (members: readonly GroupMemberRole[], memberId: string): boolean =>
  members.some(member => member.memberId === memberId);
