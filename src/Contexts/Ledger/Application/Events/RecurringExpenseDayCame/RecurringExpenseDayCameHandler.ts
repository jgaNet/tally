import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { IAuditLog } from '@Contexts/Ledger/Application/Ports/IAuditLog';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/**
 * Records a recurring expense's expense for the day that came (request 23): the expense is dated that day, paid by the payer and
 * split as the recurring expense says, under the id the day was born with (ADR 14). The fact is delivered once by the outbox, but a
 * redelivery may come: an expense already recorded under that id is left as it is, so the day is recorded once. The expense is
 * counted into the balances in this reaction's transaction, and its own fact is published from the outbox after the commit.
 */
export class RecurringExpenseDayCameHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupCurrency: IGroupCurrency,
    private clock: Clock,
    private balances: IBalanceCounts,
    private groupMembers: IGroupMembers,
    private audit: IAuditLog,
  ) {
    super();
  }

  async execute({ payload }: RecurringExpenseDayCameEvent, context: ExecutionContext): Promise<IResult<void>> {
    const expenseId = new Id(payload.expenseId);
    if (await this.expenses.findById(expenseId)) return Result.ok();

    const currency = await this.groupCurrency.currencyOf(payload.groupId);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));

    // The members are those the day's decision checked (the payer and the split), so the expense is recorded as decided.
    const now = this.clock();
    const expense = Expense.create({
      id: expenseId,
      groupId: new Id(payload.groupId),
      paidBy: new Id(payload.paidBy),
      description: payload.description,
      money: { amount: payload.amount },
      date: payload.day,
      split: payload.split,
      category: payload.category,
      groupMembers: payload.members.map(member => new Id(member)),
      groupCurrency: currency,
      offer: null,
      archived: await this.groupMembers.archivedOf(payload.groupId),
      now,
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await this.balances.count(expense.data);
    // Audited by the payer, whom the day acts for (request 28): a redelivered day finds its expense above and is not audited twice.
    await this.audit.record(payload.groupId, {
      id: `expense-recorded:${expenseId.value}`,
      at: now.toISOString(),
      by: payload.paidBy,
      action: 'expense-recorded',
      subjectId: expenseId.value,
      amount: expense.data.amount.value,
    });

    await publishDomainEvents(expense.data, context);
    return Result.ok();
  }
}
