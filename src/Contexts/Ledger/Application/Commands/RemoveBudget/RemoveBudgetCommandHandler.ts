import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { categoryOf } from '@Contexts/Ledger/Domain/Expense/Category';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { NotAllowedToChangeBudget } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget/RemoveBudgetCommandEvent';

/**
 * The owner of a group removes the budget of a category. A category with no budget has nothing to remove, and that is no
 * refusal; a member who is not the owner is refused by the budget, whether or not there is one.
 */
export class RemoveBudgetCommandHandler extends CommandHandler<RemoveBudgetCommandEvent> {
  constructor(
    private readonly budgets: IBudgetRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RemoveBudgetCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const groupId = new Id(payload.groupId);
    const category = categoryOf(payload.category);
    if (category.isFailure()) return category;
    const byOwner = (await this.groupMembers.roleOf(groupId, caller.data)) === 'owner';
    const at = this.clock();

    const existing = await this.budgets.findByCategory(groupId, category.data);
    if (!existing) {
      return byOwner ? Result.ok() : Result.fail(new NotAllowedToChangeBudget());
    }
    const removed = existing.lift({ byOwner, at });
    if (removed.isFailure()) return removed;
    if (removed.data === existing) return Result.ok();

    const saved = await this.budgets.save(removed.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(removed.data, context);
    return Result.ok();
  }
}
