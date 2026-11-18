import { Exception, IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { IBudgetStore } from '@Contexts/Ledger/Application/IBudgetStore';
import { IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { BudgetNotFoundException, NotTheOwnerException } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { CATEGORIES, Category, isCategory, monthOfDay } from '@Contexts/Ledger/Domain/Expense/Category';
import {
  GroupNotFoundException,
  InvalidExpenseCategoryException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { dayOf } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/** A budget as a member reads it: its category, its amount, and what the current month spends in the category (request 24). */
export interface BudgetView {
  readonly category: Category;
  readonly amount: number;
  readonly spent: number;
}

/** Sets a group's budget for a category; the owner only. Its amount is a whole number from 1 to 100 000 000 (request 24). */
export interface SetBudgetInput {
  readonly groupId: string;
  readonly category: string;
  readonly amount: number;
}

/**
 * Sets the monthly budget of a category in a group (request 24): the amount replaces the one it had. Only the group's owner may (`403` to
 * any other member); to someone outside the group the group does not exist (`404`). A category that is not one of the eight, and an amount
 * that is not in range, are refused (`422`). Setting a budget passes no month by itself: what it records (BudgetSet) goes out with the commit.
 */
export const setBudget = command(
  'SetBudget',
  (budgets: IBudgetStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, category, amount }: SetBudgetInput, context): Promise<IResult<void>> => {
      const owner = await ownerRefusal(groupMembers, groupId, context);
      if (owner) return Result.fail(owner);
      if (!isCategory(category)) return Result.fail(new InvalidExpenseCategoryException());

      const existing = await budgets.findByCategory(groupId, category);
      const budget = existing ?? Budget.create(groupId, category);
      const set = budget.set(amount, clock());
      if (set.isFailure()) return set;

      if (existing) await budgets.save(budget);
      else await budgets.add(budget);
      await publishDomainEvents(budget, context);
      return Result.ok(undefined);
    },
);

/**
 * Removes a group's budget for a category (request 24); the owner only, as setting one is (`403`, `404`). A category with no budget set is
 * `404`. The months it passed stay passed, so a month's notice is never made twice. What it records (BudgetRemoved) goes out with the commit.
 */
export const removeBudget = command(
  'RemoveBudget',
  (budgets: IBudgetStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, category }: { groupId: string; category: string }, context): Promise<IResult<void>> => {
      const owner = await ownerRefusal(groupMembers, groupId, context);
      if (owner) return Result.fail(owner);
      if (!isCategory(category)) return Result.fail(new InvalidExpenseCategoryException());

      const budget = await budgets.findByCategory(groupId, category);
      if (!budget) return Result.fail(new BudgetNotFoundException());
      const removed = budget.unset(clock());
      if (removed.isFailure()) return removed;

      await budgets.save(budget);
      await publishDomainEvents(budget, context);
      return Result.ok(undefined);
    },
);

/**
 * A group's budgets, as a member of the group reads them (request 24): each category that has one set, in the order of the categories,
 * with its amount and what the current month (UTC, `clock`) spends in it. To anyone outside the group the group does not exist (`404`).
 */
export const getGroupBudgets = query(
  'GetGroupBudgets',
  (budgets: IBudgetStore, expenses: IExpenseStore, groupMembers: IGroupMembers, clock: Clock) =>
    async (groupId: string, context): Promise<IResult<BudgetView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      const caller = callerOf(context);
      if (!members || !members.some(member => member.memberId === caller)) {
        return Result.fail(new GroupNotFoundException());
      }
      const month = monthOfDay(dayOf(clock()));
      const lines = (await budgets.linesOf(groupId)).sort(
        (left, right) => CATEGORIES.indexOf(left.category) - CATEGORIES.indexOf(right.category),
      );
      const views: BudgetView[] = [];
      for (const line of lines) {
        views.push({
          category: line.category,
          amount: line.amount,
          spent: await expenses.spentIn(groupId, line.category, month),
        });
      }
      return Result.ok(views);
    },
);

/**
 * Why the caller may not change a group's budgets, or `undefined` when they are its owner: a caller who is not a member of the group gets
 * the group's `404`, and a member who is not its owner gets `403` (request 24).
 */
const ownerRefusal = async (
  groupMembers: IGroupMembers,
  groupId: string,
  context: ExecutionContext,
): Promise<Exception | undefined> => {
  const members = await groupMembers.membersOf(groupId);
  const me = members?.find(member => member.memberId === callerOf(context));
  if (!members || !me) return new GroupNotFoundException();
  if (me.role !== 'owner') return new NotTheOwnerException();
  return undefined;
};
