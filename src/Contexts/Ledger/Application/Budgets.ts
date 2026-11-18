import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { NotFoundException, Result } from '@Architecture/Domain';

import { BudgetView } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { IBudgets } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgets';
import { InvalidCategoryException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { isCategory } from '@Contexts/Ledger/Domain/Expense/Category';
import { dayOf } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** What the owner of a group sets: the budget of a category, its amount in the group's currency (request 24). */
export interface SetBudgetInput {
  groupId: string;
  category: string;
  amount: number;
}

/**
 * Sets the monthly budget of a category for the group's owner (request 24, docs/adr/0023). The caller must be a member of the group, for
 * anyone else the group does not exist; any other member is refused. Setting it again replaces the amount and tells nobody: a month is
 * told of when an expense makes it pass the budget, not when the budget changes.
 */
export const setBudget = command(
  'SetBudget',
  (budgets: IBudgets, groupMembers: IGroupMembers) =>
    async ({ groupId, category, amount }: SetBudgetInput, context) => {
      const by = callerOf(context);
      const members = await groupMembers.membersOf(by, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      if (!isCategory(category)) return Result.fail(new InvalidCategoryException());

      const stored = await budgets.get(groupId, category);
      const budget = stored ?? Budget.open({ groupId, category });
      const set = budget.setAmount({ by, members, amount });
      if (set.isFailure()) return set;
      const saved = await budgets.save(set.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(set.data, context);
      return Result.ok(undefined);
    },
);

/** What the owner of a group removes: the budget of a category. */
export interface RemoveBudgetInput {
  groupId: string;
  category: string;
}

/**
 * Removes the monthly budget of a category, for the group's owner (request 24). It is `404` when none is set. The months it was passed in
 * are kept, so a month is never told twice.
 */
export const removeBudget = command(
  'RemoveBudget',
  (budgets: IBudgets, groupMembers: IGroupMembers) =>
    async ({ groupId, category }: RemoveBudgetInput, context) => {
      const by = callerOf(context);
      const members = await groupMembers.membersOf(by, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      if (!isCategory(category)) return Result.fail(new InvalidCategoryException());

      const stored = await budgets.get(groupId, category);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such budget'));
      const removed = stored.unset({ by, members });
      if (removed.isFailure()) return removed;
      const saved = await budgets.save(removed.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(removed.data, context);
      return Result.ok(undefined);
    },
);

/**
 * The group's budgets, for its members only (request 24): each category that has one, in the order of the categories, with its amount and
 * what the current month (UTC) spends in it. For anyone else the group does not exist.
 */
export const getGroupBudgets = query(
  'GetGroupBudgets',
  (queries: IBudgetQueries, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId }: { groupId: string }, context) => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const views: BudgetView[] = await queries.listOf(groupId, dayOf(clock()).slice(0, 7));
      return Result.ok(views);
    },
);
