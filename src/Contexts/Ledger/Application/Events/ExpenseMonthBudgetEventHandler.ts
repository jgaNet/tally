import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { IMonthlySpend } from '@Contexts/Ledger/Domain/Budget/Ports/IMonthlySpend';

/**
 * When an expense is recorded or edited, its month is judged against the budget of its category (request 24): what the
 * month spends in the category, read now, is given to the budget, which records BudgetPassed once for the month when it is
 * more than the budget. The members to tell are read through Groups when it is decided. The reaction runs in a transaction of
 * its own, and the fact reaches the outbox with its writes; a category with no budget records nothing.
 */
export class ExpenseMonthBudgetEventHandler extends EventHandler<ExpenseRecordedEvent | ExpenseEditedEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly budgets: IBudgetRepository,
    private readonly spending: IMonthlySpend,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: ExpenseRecordedEvent | ExpenseEditedEvent,
    context: ExecutionContext,
  ): Promise<IResult<unknown>> {
    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.ok();
    const budget = await this.budgets.findByCategory(expense.groupId, expense.category);
    if (!budget) return Result.ok();

    const month = expense.date.value.slice(0, 7);
    const spent = await this.spending.spentInMonth(expense.groupId, expense.category, month);
    // Tally tells a deleted account nothing any more (request 35): it is left out of the members the notice is for.
    const current = await this.groupMembers.currentMembers(expense.groupId);
    const deleted = await this.groupMembers.deletedAmong(current);
    const judged = budget.judge({
      month,
      spent,
      memberIds: current.filter(member => !deleted.some(gone => gone.equals(member))),
      at: this.clock(),
    });
    if (judged === budget) return Result.ok();

    const saved = await this.budgets.save(judged);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(judged, context);
    return Result.ok();
  }
}
