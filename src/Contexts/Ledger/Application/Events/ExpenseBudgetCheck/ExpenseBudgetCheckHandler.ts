import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { IBudgetSpending } from '@Contexts/Ledger/Application/Ports/IBudgetSpending';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * The policy of a recorded or edited expense (request 24): what the expense's month now spends in its category is read from Ledger's
 * own expenses, and the category's budget, when there is one, decides whether the month has passed it for the first time. The budget
 * keeps the months it was passed in, so a month is told once; when it passes, its fact is saved with the budget in this reaction's
 * transaction and published from the outbox after the commit (EVENT-AFTER-COMMIT). An expense deleted since, or a category with no
 * budget, makes nothing.
 */
export class ExpenseBudgetCheckHandler extends EventHandler<ExpenseRecordedEvent | ExpenseEditedEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private budgets: IBudgetRepository,
    private spending: IBudgetSpending,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute(
    { payload }: ExpenseRecordedEvent | ExpenseEditedEvent,
    context: ExecutionContext,
  ): Promise<IResult<void>> {
    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.ok();

    const budget = await this.budgets.findByGroupAndCategory(expense.groupId, expense.category.value);
    if (!budget || budget.removed) return Result.ok();

    const month = expense.spentOn.value.slice(0, 7);
    const spent = await this.spending.spentIn(expense.groupId.value, expense.category.value, month);
    // A deleted account is told nothing any more (request 35): it is left out of the members the budget's notice is for.
    const members = await this.groupMembers.membersOf(expense.groupId.value);
    const deleted = await this.groupMembers.deletedAmong(members);
    const decided = budget.pass({
      month,
      spent,
      members: members.filter(member => !deleted.some(gone => gone.value === member.value)),
    });
    if (decided === budget) return Result.ok();

    const saved = await this.budgets.save(decided);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(decided, context);
    return Result.ok();
  }
}
