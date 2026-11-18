import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { categoryOf } from '@Contexts/Ledger/Domain/Expense/Category';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense/SetUpRecurringExpenseCommandEvent';

/**
 * A member sets up an expense they pay every month (request 23): the caller is its payer, and the split is checked as an
 * expense's is (the members of the group, listed once, the payer among them, the exact amounts adding up). Its day of the
 * first month is a real day, from the 1st to the 28th, no more than 365 days from today. The result is its id; the
 * background job records its expenses from then on.
 */
export class SetUpRecurringExpenseCommandHandler extends CommandHandler<SetUpRecurringExpenseCommandEvent> {
  constructor(
    private readonly recurring: IRecurringExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: SetUpRecurringExpenseCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string }>> {
    const payer = requireSignedIn(context, 'Ledger');
    if (payer.isFailure()) return payer;

    const groupId = new Id(payload.groupId);
    const groupArchived = await this.groupMembers.isArchived(groupId);
    const category = categoryOf(payload.category);
    if (category.isFailure()) return category;
    const recurring = RecurringExpense.setUp({
      groupId,
      payer: payer.data,
      description: payload.description,
      amount: payload.amount,
      startsOn: payload.startsOn,
      category: category.data,
      request: payload,
      groupMembers: await this.groupMembers.currentMembers(groupId),
      groupArchived,
      at: this.clock(),
    });
    if (recurring.isFailure()) return recurring;

    const saved = await this.recurring.save(recurring.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(recurring.data, context);
    return Result.ok({ id: recurring.data._id.value });
  }
}
