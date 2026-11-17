import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IExpenseStore, ExpenseView } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseNotFoundException, GroupNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** An expense as the request carries it: the group it is in, and the rest of the draft; the payer is the caller. */
export interface RecordExpenseInput {
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly splitBetween: readonly string[];
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
      if (!members || !members.includes(payerId)) return Result.fail(new GroupNotFoundException());

      const recorded = Expense.register({ groupId, payerId, ...draft }, members, clock());
      if (recorded.isFailure()) return recorded;

      await expenses.add(recorded.data);
      await publishDomainEvents(recorded.data, context);
      return Result.ok(recorded.data.toSnapshot().id);
    },
);

/**
 * An expense as a member of its group reads it: its description, amount, date, payer and each member's share, in the order
 * the split was given. To anyone else it does not exist: the same `404` for an expense that is not there and one of a group
 * the caller is not in.
 */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async (expenseId: string, context): Promise<IResult<ExpenseView>> => {
      const view = await expenses.viewOf(expenseId);
      if (!view) return Result.fail(new ExpenseNotFoundException());

      const members = await groupMembers.membersOf(view.groupId);
      if (!members || !members.includes(callerOf(context))) return Result.fail(new ExpenseNotFoundException());
      return Result.ok(view);
    },
);
