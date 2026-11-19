import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { decideRemoveBudget, decideSetBudget } from '@Contexts/Ledger/Domain/Budget/Budget.decision';
import { EXPENSE_CATEGORIES, isExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

import { BudgetView, IBudgetQueries } from './IBudgetQueries';
import { IBudgetRepository } from './IBudgetRepository';
import { IExpenseQueries } from './IExpenseQueries';
import { IGroupMembers, MemberOfGroup } from './IGroupMembers';

/**
 * The group's owner sets the monthly budget of a category (request 24), in the group's currency, from 1 to 100 000 000; setting it again
 * replaces it, and sets no notice by itself. Any other member is refused; anyone who is not a member gets the answer for a group that
 * does not exist.
 */
export const setBudget = command(
  'SetBudget',
  (budgets: IBudgetRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, category, amount }: { groupId: string; category: string; amount: number }, context) => {
      return budgets.inTransaction(async () => {
        const by = callerOf(context);
        const members = await groupMembers.membersOf(groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));

        const decision = decideSetBudget(
          { ownerId: ownerIdOf(members), archived: await groupMembers.archivedOf(groupId) },
          { by, category, amount },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const stored = await budgets.get(groupId, decision.data.state.category);
        if (stored) {
          stored.setAmount(decision.data.state.amount, clock());
          await budgets.save(stored);
          await publishDomainEvents(stored, context);
        } else {
          const created = Budget.create({ groupId, ...decision.data.state, at: clock() });
          await budgets.insert(created);
          await publishDomainEvents(created, context);
        }
        return Result.ok(undefined);
      });
    },
);

/**
 * The group's owner removes the budget of a category (request 24). Any other member is refused; a category that has none is not found;
 * anyone who is not a member gets the answer for a group that does not exist.
 */
export const removeBudget = command(
  'RemoveBudget',
  (budgets: IBudgetRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, category }: { groupId: string; category: string }, context) => {
      return budgets.inTransaction(async () => {
        const by = callerOf(context);
        const members = await groupMembers.membersOf(groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
        const stored = isExpenseCategory(category) ? await budgets.get(groupId, category) : undefined;

        const decision = decideRemoveBudget(
          {
            ownerId: ownerIdOf(members),
            budget: stored?.toSnapshot(),
            archived: await groupMembers.archivedOf(groupId),
          },
          { by, category },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const budget = stored as Budget;
        budget.retire();
        await budgets.save(budget);
        await publishDomainEvents(budget, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * A member of a group reads its budgets (request 24): each category that has one, in the order of the categories, with its amount and
 * what the current month (UTC) spends in it. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getGroupBudgets = query(
  'GetGroupBudgets',
  (budgets: IBudgetQueries, expenses: IExpenseQueries, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      if (!(await groupMembers.membersOf(id, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      }
      const spent = await expenses.spentByCategory(id, clock().toISOString().slice(0, 7));
      const amounts = new Map((await budgets.budgetsOf(id)).map(({ category, amount }) => [category, amount]));
      const answer: BudgetView[] = EXPENSE_CATEGORIES.filter(category => amounts.has(category)).map(category => ({
        category,
        amount: amounts.get(category)!,
        spent: spent.get(category) ?? 0,
      }));
      return Result.ok(answer);
    },
);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';
