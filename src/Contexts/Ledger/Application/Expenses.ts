import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Expense, ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';
import {
  decideRecordExpense,
  decideEditExpense,
  decideDeleteExpense,
} from '@Contexts/Ledger/Domain/Expense/Expense.decision';

import { IGroupMembers, MemberOfGroup } from './IGroupMembers';
import { BalanceView, ExpenseView, IExpenseQueries } from './IExpenseQueries';
import { IExpenseRepository } from './IExpenseRepository';

/** What a member records: the group, the expense as typed, and the members it is split between, in the order chosen. */
export interface RecordExpenseInput {
  groupId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

/** What a change to an expense says: which expense, the expense as typed, and the version its author read it at. */
export interface EditExpenseInput {
  id: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
  version: number;
}

/**
 * A member of a group records an expense they paid, split equally between members of the group, the payer among them.
 * The payer is the caller. Anyone who is not a member gets the answer for a group that does not exist. Answers the new
 * expense's id.
 */
export const recordExpense = command(
  'RecordExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, description, amount, date, splitBetween }: RecordExpenseInput, context) => {
      const payer = callerOf(context);
      const members = await groupMembers.membersOf(groupId, payer);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));

      const decision = decideRecordExpense(
        { memberIds: memberIdsOf(members) },
        { description, amount, date, splitBetween, payer },
        clock(),
      );
      if (decision.isFailure()) return decision;

      const expense = Expense.register({ groupId, ...decision.data.state });
      await expenses.insert(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(expense._id.value);
    },
);

/**
 * The payer of an expense, or the group's owner, gives it again, whole, from the version they read (feature 6). Any other
 * member is refused; anyone who is not a member gets the answer for an expense that does not exist. An edit made from a
 * version the expense has left is refused by name; two edits at once from one version keep one, and the other is re-read
 * and refused the same way (CONC-OPTIMISTIC).
 */
export const editExpense = command(
  'EditExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id, description, amount, date, splitBetween, version }: EditExpenseInput, context) => {
      const by = callerOf(context);
      const expense = await expenses.get(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      const stored = expense.toSnapshot();
      const members = await groupMembers.membersOf(stored.groupId, by);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));

      const decision = decideEditExpense(
        { expense: stored, memberIds: memberIdsOf(members), ownerId: ownerIdOf(members) },
        { by, description, amount, date, splitBetween, version },
        clock(),
      );
      if (decision.isFailure()) return decision;

      expense.revise(decision.data.state);
      await expenses.save(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/**
 * The payer of an expense, or the group's owner, deletes it (feature 6): it is no longer read, and counts in no balance.
 * Any other member is refused; anyone who is not a member gets the answer for an expense that does not exist.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      const expense = await expenses.get(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      const stored: ExpenseSnapshot = expense.toSnapshot();
      const members = await groupMembers.membersOf(stored.groupId, by);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));

      const decision = decideDeleteExpense(
        { expense: stored, memberIds: memberIdsOf(members), ownerId: ownerIdOf(members) },
        { by },
        clock(),
      );
      if (decision.isFailure()) return decision;

      expense.delete();
      await expenses.remove(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/** A member of the expense's group reads it; anyone else, or nobody, gets the answer for an expense that does not exist. */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const expense: ExpenseView | undefined = await expenses.expenseOf(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      if (!(await groupMembers.membersOf(expense.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      }
      return Result.ok(expense);
    },
);

/**
 * A member of a group reads every member's balance, in the order they joined (the order Groups gives them): what the
 * member paid for the group's expenses less their shares in them, so the balances add up to 0. Anyone who is not a member
 * gets the answer for a group that does not exist.
 */
export const getGroupBalances = query(
  'GetGroupBalances',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const members = await groupMembers.membersOf(id, callerOf(context));
      if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      const balances = await expenses.balancesOf(id);
      const answer: BalanceView[] = memberIdsOf(members).map(memberId => ({
        memberId,
        balance: balances.get(memberId) ?? 0,
      }));
      return Result.ok(answer);
    },
);

const memberIdsOf = (members: MemberOfGroup[]): string[] => members.map(member => member.memberId);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';
