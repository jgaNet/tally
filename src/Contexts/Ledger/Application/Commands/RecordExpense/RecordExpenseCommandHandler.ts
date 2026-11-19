import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { categoryOf } from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { splitOfExpense } from '@Contexts/Ledger/Application/Commands/splitOfExpense';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { priceExpense } from '@Contexts/Ledger/Application/Commands/priceExpense';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';
import { IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';

/**
 * A member records an expense they paid, split between the members it concerns: equally, by exact amounts, or by shares.
 * The payer is the caller; the members of the split are asked of Groups when the expense is decided, so a member who has
 * just joined can be in it. An expense in another currency takes the rate offered for its day when it gives none (request
 * 22). The result is the expense's id, and where its rate came from (`rateSource`, null in the group's currency).
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly templates: ISplitTemplateRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly groupCurrency: IGroupCurrency,
    private readonly offeredRates: IOfferedRates,
    private readonly clock: Clock,
    private readonly audit: IAuditTrail,
  ) {
    super();
  }

  async execute(
    { payload }: RecordExpenseCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string; rateSource: string | null }>> {
    const payer = requireSignedIn(context, 'Ledger');
    if (payer.isFailure()) return payer;

    const now = this.clock();
    const description = Description.create(payload.description);
    if (description.isFailure()) return description;
    const groupId = new Id(payload.groupId);
    const groupArchived = await this.groupMembers.isArchived(groupId);
    const payerSuspended = await this.groupMembers.isSuspended(payer.data);
    const date = ExpenseDate.create(payload.date, now);
    if (date.isFailure()) return date;
    const priced = await priceExpense(payload, groupId, date.data, this.groupCurrency, this.offeredRates);
    if (priced.isFailure()) return priced;
    const split = await splitOfExpense({
      amount: priced.data.amount,
      payer: payer.data,
      groupId: groupId,
      request: payload,
      templates: this.templates,
    });
    if (split.isFailure()) return split;
    const category = categoryOf(payload.category);
    if (category.isFailure()) return category;

    const expense = Expense.create({
      groupId,
      description: description.data,
      amount: priced.data.amount,
      original: priced.data.original,
      category: category.data,
      date: date.data,
      split: split.data,
      groupMembers: await this.groupMembers.currentMembers(groupId),
      groupArchived,
      callerSuspended: payerSuspended,
      at: now,
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    const recorded = expense.data.toSnapshot();
    await this.audit.record({
      id: `expense-recorded:${recorded.id}:0`,
      groupId: recorded.groupId,
      at: now,
      by: payer.data.value,
      action: 'expense-recorded',
      subjectId: recorded.id,
      amount: recorded.amount,
    });
    await publishDomainEvents(expense.data, context);
    return Result.ok({ id: expense.data._id.value, rateSource: priced.data.rateSource });
  }
}
