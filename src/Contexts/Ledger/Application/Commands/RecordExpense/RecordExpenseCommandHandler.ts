import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';

/**
 * A member records an expense they paid, split between the members it concerns: equally, by exact amounts, or by shares.
 * The payer is the caller; the members of the split are asked of Groups when the expense is decided, so a member who has
 * just joined can be in it. The result is the expense's id.
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RecordExpenseCommandEvent, context: ExecutionContext): Promise<IResult<{ id: string }>> {
    const payer = requireSignedIn(context, 'Ledger');
    if (payer.isFailure()) return payer;

    const now = this.clock();
    const description = Description.create(payload.description);
    if (description.isFailure()) return description;
    const amount = Amount.create(payload.amount);
    if (amount.isFailure()) return amount;
    const date = ExpenseDate.create(payload.date, now);
    if (date.isFailure()) return date;
    const split = Split.fromRequest({ amount: amount.data, payer: payer.data, request: payload });
    if (split.isFailure()) return split;

    const groupId = new Id(payload.groupId);
    const expense = Expense.create({
      groupId,
      description: description.data,
      amount: amount.data,
      date: date.data,
      split: split.data,
      groupMembers: await this.groupMembers.currentMembers(groupId),
      at: now,
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(expense.data, context);
    return Result.ok({ id: expense.data._id.value });
  }
}
