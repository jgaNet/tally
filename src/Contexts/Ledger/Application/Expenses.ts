import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** What a member asks to record: the group, and the expense as the member gives it. */
export interface RecordExpenseInput {
  groupId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

/**
 * Records an expense the caller paid, split equally between the members given, in the order given. The caller is its
 * payer and must be a member of the group: for anyone else the group does not exist. Its id is the answer.
 */
export const recordExpense = command(
  'RecordExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, description, amount, date, splitBetween }: RecordExpenseInput, context) => {
      const paidBy = callerOf(context);
      const members = await groupMembers.membersOf(paidBy, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));

      const expense = Expense.register({
        groupId,
        description,
        amount,
        date,
        paidBy,
        splitBetween,
        members,
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
