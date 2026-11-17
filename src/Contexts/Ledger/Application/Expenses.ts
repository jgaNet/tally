import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { IExpenseStore, ExpenseView } from '@Contexts/Ledger/Application/IExpenseStore';
import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import {
  ExpenseNotFoundException,
  GroupNotFoundException,
  NotThePayerOrOwnerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';

/** An expense as the request carries it: the group it is in, and the rest of the draft; the payer is the caller. */
export interface RecordExpenseInput {
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly split: SplitDraft;
}

/**
 * An edit as the request carries it: the expense it changes, the expense given again whole, and the version its author read.
 * The payer is not in it: an edit never changes who paid.
 */
export interface EditExpenseInput {
  readonly expenseId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly split: SplitDraft;
  readonly version: number;
}

/**
 * Records an expense the signed-in person paid, split between the members the request names. The group is read through the
 * owned port: a caller who is not one of its members gets the group's `404`, since the group is not there for them. The
 * expense is saved with its shares, and what it recorded (ExpenseRecorded) goes out with the commit, through the outbox.
 * Answers the new expense's id.
 */
export const recordExpense = command(
  'RecordExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, ...draft }: RecordExpenseInput, context): Promise<IResult<string>> => {
      const payerId = callerOf(context);
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, payerId)) return Result.fail(new GroupNotFoundException());

      const recorded = Expense.register(
        { groupId, payerId, ...draft },
        members.map(member => member.memberId),
        clock(),
      );
      if (recorded.isFailure()) return recorded;

      await expenses.add(recorded.data);
      await publishDomainEvents(recorded.data, context);
      return Result.ok(recorded.data.toSnapshot().id);
    },
);

/**
 * Edits an expense: given again whole, from the version its author read (request 6). Only its payer or the group's owner may
 * (`403` to any other member); to someone outside the group the expense does not exist (`404`). The payer stays the one who
 * paid. An edit from another version is refused with `ExpenseChanged` (`409`), and the author reads it again and decides. The
 * expense is saved at the version it was read at, so of two edits from one version, one is kept, and the other is refused by
 * that same rule once it has read the expense again. What it recorded (ExpenseEdited) goes out with the commit.
 */
export const editExpense = command(
  'EditExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ expenseId, version, ...draft }: EditExpenseInput, context): Promise<IResult<void>> => {
      const found = await changeable(expenses, groupMembers, expenseId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { expense, members } = found.data;

      const edited = expense.edit(
        draft,
        members.map(member => member.memberId),
        version,
        clock(),
      );
      if (edited.isFailure()) return Result.fail(edited.error);

      await expenses.save(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/**
 * Deletes an expense: it is no longer there for anyone, and counts in no balance (request 6). Only its payer or the group's
 * owner may (`403` to any other member); to someone outside the group the expense does not exist (`404`). What it recorded
 * (ExpenseDeleted) goes out with the commit.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async (expenseId: string, context): Promise<IResult<void>> => {
      const found = await changeable(expenses, groupMembers, expenseId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { expense, members } = found.data;

      const deleted = expense.delete(
        members.map(member => member.memberId),
        clock(),
      );
      if (deleted.isFailure()) return Result.fail(deleted.error);
      await expenses.remove(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/**
 * An expense as a member of its group reads it: its description, amount, date, payer, each member's share in the order the
 * split was given, and the version it is at. To anyone else it does not exist: the same `404` for an expense that is not there
 * and one of a group the caller is not in.
 */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async (expenseId: string, context): Promise<IResult<ExpenseView>> => {
      const view = await expenses.viewOf(expenseId);
      if (!view) return Result.fail(new ExpenseNotFoundException());

      const members = await groupMembers.membersOf(view.groupId);
      if (!members || !isMember(members, callerOf(context))) return Result.fail(new ExpenseNotFoundException());
      return Result.ok(view);
    },
);

/**
 * The expense a caller may change, as the caller may see it: it is there for them (an expense of a group they are a member of,
 * else the same `404` as one that does not exist), and they are its payer or the group's owner (else `403`). Answers the
 * expense and the group's members, the ones the split may be in.
 */
async function changeable(
  expenses: IExpenseStore,
  groupMembers: IGroupMembers,
  expenseId: string,
  context: ExecutionContext,
): Promise<IResult<{ expense: Expense; members: GroupMemberRole[] }>> {
  const expense = await expenses.findById(expenseId);
  if (!expense) return Result.fail(new ExpenseNotFoundException());

  const { groupId, paidBy } = expense.toSnapshot();
  const members = await groupMembers.membersOf(groupId);
  const caller = callerOf(context);
  const me = members?.find(member => member.memberId === caller);
  if (!members || !me) return Result.fail(new ExpenseNotFoundException());
  if (paidBy !== caller && me.role !== 'owner') return Result.fail(new NotThePayerOrOwnerException());

  return Result.ok({ expense, members });
}

const isMember = (members: readonly GroupMemberRole[], memberId: string): boolean =>
  members.some(member => member.memberId === memberId);
