import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { decideRecordExpense } from '@Contexts/Ledger/Domain/Expense/Expense.decision';

import { IGroupMembers } from './IGroupMembers';
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
      const memberIds = await groupMembers.membersOf(groupId, payer);
      if (!memberIds) return Result.fail(new NotFoundException('Ledger', 'No group is found'));

      const decision = decideRecordExpense({ memberIds }, { description, amount, date, splitBetween, payer }, clock());
      if (decision.isFailure()) return decision;

      const expense = Expense.register({ groupId, ...decision.data.state });
      await expenses.insert(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(expense._id.value);
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
      const memberIds = await groupMembers.membersOf(id, callerOf(context));
      if (!memberIds) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      const balances = await expenses.balancesOf(id);
      const answer: BalanceView[] = memberIds.map(memberId => ({ memberId, balance: balances.get(memberId) ?? 0 }));
      return Result.ok(answer);
    },
);
