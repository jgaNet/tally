import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget/RemoveBudgetCommandEvent';
import { BudgetNotSet, NotTheOwnerOfTheGroup } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * The signed-in owner of a group removes its budget for a category. For anyone who is not a member the group does not exist; a member
 * who is not the owner is refused, as is removing a budget that is not set. The role is read from Groups through the port Ledger owns.
 */
export class RemoveBudgetCommandHandler extends CommandHandler<RemoveBudgetCommandEvent> {
  constructor(
    private budgets: IBudgetRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: RemoveBudgetCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const role = await this.groupMembers.roleOf(payload.groupId, caller.data);
    if (!role) return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));
    if (role !== 'owner') return Result.fail(new NotTheOwnerOfTheGroup());

    const category = Category.create(payload.category);
    if (category.isFailure()) return category;

    const budget = await this.budgets.findByGroupAndCategory(new Id(payload.groupId), category.data.value);
    if (!budget) return Result.fail(new BudgetNotSet());

    const removed = budget.unset({ byOwner: true });
    if (removed.isFailure()) return removed;

    const saved = await this.budgets.save(removed.data);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(removed.data, context);
    return Result.ok(removed.data._id.value);
  }
}
