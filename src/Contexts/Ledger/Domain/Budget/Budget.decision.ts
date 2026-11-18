import { NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { categoryOf, ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

import { BudgetAmount } from './BudgetAmount';
import { BudgetSnapshot } from './Budget';

/** Who may set or remove a budget: the group's owner, and no one else. */
const OWNER_ONLY = "Only the group's owner may set or remove its budgets";

/** What a setting says: the caller, the category as typed, and the amount. */
export interface SetBudgetCommand {
  by: string;
  category: string;
  amount: number;
}

/** The group's owner, against whom the caller is checked. The caller is a member: the use case asked Groups before it decided. */
export interface BudgetAccess {
  ownerId: string;
}

/** The values a budget is set with, once they are allowed. */
export interface BudgetValues {
  category: ExpenseCategory;
  amount: BudgetAmount;
}

/**
 * Setting a budget (request 24): only the group's owner may, and any other member is refused. The category is one of the eight and the
 * amount a whole number from 1 to 100 000 000. Setting it again replaces it.
 */
export const decideSetBudget: Decision<BudgetValues, SetBudgetCommand, never, BudgetAccess> = (
  { ownerId },
  { by, category: rawCategory, amount: rawAmount },
) => {
  if (by !== ownerId) return Result.fail(new NotAllowedException('Ledger', OWNER_ONLY));
  const category = categoryOf(rawCategory);
  if (category.isFailure()) return category;
  const amount = BudgetAmount.create(rawAmount);
  if (amount.isFailure()) return amount;
  return decided({ category: category.data, amount: amount.data });
};

/** What a removal says: the caller and the category as typed. */
export interface RemoveBudgetCommand {
  by: string;
  category: string;
}

/** What a removal is decided against: the owner, and the category's budget as it is stored, if there is one. */
export interface StoredBudgetAccess extends BudgetAccess {
  budget: BudgetSnapshot | undefined;
}

/** Removing a budget (request 24): only the group's owner may; a category that has no budget has nothing to remove. */
export const decideRemoveBudget: Decision<ExpenseCategory, RemoveBudgetCommand, never, StoredBudgetAccess> = (
  { ownerId, budget },
  { by, category: rawCategory },
) => {
  if (by !== ownerId) return Result.fail(new NotAllowedException('Ledger', OWNER_ONLY));
  const category = categoryOf(rawCategory);
  if (category.isFailure()) return category;
  if (budget === undefined || budget.amount === undefined) {
    return Result.fail(new NotFoundException('Ledger', 'No budget is found'));
  }
  return decided(category.data);
};

/** What a month's spending is decided against: the budget of the category as it is stored, what the month spends, and the members to tell. */
export interface MonthSpending {
  budget: BudgetSnapshot | undefined;
  spent: number;
  memberIds: readonly string[];
}

/** What a month's spending decides: it is within the budget (or the budget has been passed in it already, or there is none), or it passes it. */
export type PassOutcome =
  { kind: 'nothing' } | { kind: 'passed'; month: string; spent: number; memberIds: readonly string[] };

/**
 * Whether a month passes its category's budget (request 24): when the category has a budget and what the month spends is more than it,
 * and the budget has not been passed in that month before. Once a month: a month that goes further over, or comes back under and over
 * again, passes nothing more.
 */
export const decidePassBudget: Decision<PassOutcome, { month: string }, never, MonthSpending> = (
  { budget, spent, memberIds },
  { month },
) => {
  if (budget === undefined || budget.amount === undefined) return decided({ kind: 'nothing' });
  if (spent <= budget.amount || budget.passedMonths.includes(month)) return decided({ kind: 'nothing' });
  return decided({ kind: 'passed', month, spent, memberIds });
};
