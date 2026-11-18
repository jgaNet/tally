import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { categoryOf } from '@Contexts/Ledger/Domain/Expense/Category';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget/SetBudgetCommandEvent';

/**
 * The owner of a group sets the budget of a category, or sets it again: the caller's role is read through Groups, and the
 * budget decides whether that role may set it (only the owner). The result is nothing but the outcome.
 */
export class SetBudgetCommandHandler extends CommandHandler<SetBudgetCommandEvent> {
  constructor(
    private readonly budgets: IBudgetRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SetBudgetCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const groupId = new Id(payload.groupId);
    const category = categoryOf(payload.category);
    if (category.isFailure()) return category;
    const byOwner = (await this.groupMembers.roleOf(groupId, caller.data)) === 'owner';
    const at = this.clock();

    const existing = await this.budgets.findByCategory(groupId, category.data);
    const budget = existing
      ? existing.amend({ byOwner, amount: payload.amount, at })
      : Budget.establish({ groupId, category: category.data, amount: payload.amount, byOwner, at });
    if (budget.isFailure()) return budget;

    const saved = await this.budgets.save(budget.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(budget.data, context);
    return Result.ok();
  }
}
