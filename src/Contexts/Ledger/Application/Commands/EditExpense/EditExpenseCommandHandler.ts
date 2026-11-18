import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { categoryOf } from '@Contexts/Ledger/Domain/Expense/Category';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { splitOfExpense } from '@Contexts/Ledger/Application/Commands/splitOfExpense';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { priceExpense } from '@Contexts/Ledger/Application/Commands/priceExpense';
import { EditExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/EditExpense/EditExpenseCommandEvent';
import { IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';

/**
 * A member who paid an expense, or the owner of its group, gives it again, whole, from the version they read. The
 * expense is read afresh and decided on what it is now: a member who is not in the group does not see it at all, and
 * one who is, but neither paid it nor owns the group, is refused by the aggregate. The shares are computed again, under
 * the rules of recording (the same members, or the same kind of split with the new values); the payer stays the one who
 * paid. An expense in another currency takes the rate offered for its day when it gives none (request 22).
 */
export class EditExpenseCommandHandler extends CommandHandler<EditExpenseCommandEvent> {
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
    { payload }: EditExpenseCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string; rateSource: string | null }>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const now = this.clock();
    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const role = await this.groupMembers.roleOf(expense.groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const groupArchived = await this.groupMembers.isArchived(expense.groupId);

    const description = Description.create(payload.description);
    if (description.isFailure()) return description;
    const date = ExpenseDate.create(payload.date, now);
    if (date.isFailure()) return date;
    const priced = await priceExpense(payload, expense.groupId, date.data, this.groupCurrency, this.offeredRates);
    if (priced.isFailure()) return priced;
    const split = await splitOfExpense({
      amount: priced.data.amount,
      payer: expense.payer,
      groupId: expense.groupId,
      request: payload,
      templates: this.templates,
    });
    if (split.isFailure()) return split;
    const category = categoryOf(payload.category);
    if (category.isFailure()) return category;

    const before = expense.toSnapshot();
    const edited = expense.edit({
      by: caller.data,
      byOwner: role === 'owner',
      fromVersion: payload.version,
      description: description.data,
      amount: priced.data.amount,
      original: priced.data.original,
      category: category.data,
      date: date.data,
      split: split.data,
      groupMembers: await this.groupMembers.currentMembers(expense.groupId),
      groupArchived,
      at: now,
    });
    if (edited.isFailure()) return edited;

    const saved = await this.expenses.save(edited.data);
    if (saved.isFailure()) return saved;
    await this.audit.record({
      id: `expense-edited:${before.id}:${before.version}`,
      groupId: before.groupId,
      at: now,
      by: caller.data.value,
      action: 'expense-edited',
      subjectId: before.id,
      amount: edited.data.toSnapshot().amount,
    });
    await publishDomainEvents(edited.data, context);
    return Result.ok({ id: expense._id.value, rateSource: priced.data.rateSource });
  }
}
