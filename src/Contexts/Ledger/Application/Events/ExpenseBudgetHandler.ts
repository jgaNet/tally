import { EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';

import { IBudgets } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgets';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IMonthlySpending } from '@Contexts/Ledger/Domain/Expense/Ports/IMonthlySpending';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * The policy on an expense recorded or edited (request 24, docs/adr/0023), in a transaction of its own: the expense's month spends what it
 * spends in the expense's category, read here, and the category's budget decides whether that month passed it. The budget answers itself
 * when nothing passed (no budget, not over it, or the month told already), and then nothing is stored. The members to tell are the group's
 * current members, read when the month passes. A fact that comes again finds the month passed and tells nobody twice.
 */
export class ExpenseBudgetHandler extends EventHandler<ExpenseRecordedEvent | ExpenseEditedEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly budgets: IBudgets,
    private readonly spending: IMonthlySpending,
    private readonly groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute(event: ExpenseRecordedEvent | ExpenseEditedEvent, context: ExecutionContext) {
    const expense = await this.expenses.get(event.payload.expenseId);
    // An expense deleted since the fact was made is in no month: nothing is passed.
    if (!expense) return Result.ok(undefined);

    const budget = await this.budgets.get(expense.groupId, expense.category);
    if (!budget || budget.amount === undefined) return Result.ok(undefined);

    const month = expense.date.slice(0, 7);
    const spent = await this.spending.spentIn(expense.groupId, expense.category, month);
    if (spent <= budget.amount) return Result.ok(undefined);

    const memberIds = await this.groupMembers.currentMemberIds(expense.groupId);
    const decided = budget.pass({ month, spent, memberIds });
    if (decided === budget) return Result.ok(undefined);

    const saved = await this.budgets.save(decided);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(decided, context);
    return Result.ok(undefined);
  }
}
