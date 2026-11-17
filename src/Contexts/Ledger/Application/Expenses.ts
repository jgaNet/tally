import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a member asks to record: the group, and the expense as the member gives it, with how it is split. */
export interface RecordExpenseInput {
  groupId: string;
  description: string;
  amount: number;
  date: string;
  split: SplitInput;
}

/**
 * Records an expense the caller paid, split equally, by exact amounts or by shares between the members given (request 4 and
 * request 7). The caller is its payer and must be a member of the group: for anyone else the group does not exist. Its id is
 * the answer.
 */
export const recordExpense = command(
  'RecordExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, description, amount, date, split }: RecordExpenseInput, context) => {
      const paidBy = callerOf(context);
      const members = await groupMembers.membersOf(paidBy, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));

      const expense = Expense.register({
        groupId,
        description,
        amount,
        date,
        paidBy,
        split,
        members: members.map(member => member.memberId),
        at: clock(),
      });
      if (expense.isFailure()) return expense;

      const saved = await expenses.save(expense.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(expense.data, context);
      return Result.ok(expense.data.id);
    },
);

/** Reads an expense, for the members of its group only: for anyone else it does not exist. */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const expense = await expenses.findExpense(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(callerOf(context), expense.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      return Result.ok(expense);
    },
);

/** What a member asks to change: the expense, and the whole of it as the member gives it, from the version they read. */
export interface EditExpenseInput {
  id: string;
  description: string;
  amount: number;
  date: string;
  split: SplitInput;
  version: number;
}

/**
 * Gives an expense again, whole, from the version its author read (request 6, docs/adr/0006). The caller must be a member
 * of its group, for anyone else the expense does not exist; the payer or the group's owner may change it. The payer stays
 * the one who paid. A version the expense has moved past is refused by name, after the store's conflict is re-read.
 */
export const editExpense = command(
  'EditExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id, description, amount, date, split, version }: EditExpenseInput, context) => {
      const by = callerOf(context);
      const stored = await expenses.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));

      const edited = stored.edit({ by, members, version, description, amount, date, split, at: clock() });
      if (edited.isFailure()) return edited;
      const saved = await expenses.save(edited.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(edited.data, context);
      return Result.ok(undefined);
    },
);

/**
 * Deletes an expense, for its payer or the group's owner (request 6, docs/adr/0006). It is gone from every read and counts in
 * no balance from the commit on. For anyone outside its group the expense does not exist.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      const stored = await expenses.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));

      const removed = stored.remove({ by, members });
      if (removed.isFailure()) return removed;
      const saved = await expenses.remove(removed.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(removed.data, context);
      return Result.ok(undefined);
    },
);

/**
 * A group's balances, for its members only: each member, in the order they joined, with what they are owed (positive) or
 * owe (negative), 0 when nothing is recorded for them. For anyone else the group does not exist.
 *
 * The balances are read before the members, and membership only grows (leaving is a later feature, docs/adr/0005): so
 * the members read after include every member the balances count, and the balances listed add up to 0 exactly.
 */
export const getGroupBalances = query(
  'GetGroupBalances',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const balances = await expenses.balancesOf(groupId);
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const owed = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
      return Result.ok(members.map(({ memberId }) => ({ memberId, balance: owed.get(memberId) ?? 0 })));
    },
);
