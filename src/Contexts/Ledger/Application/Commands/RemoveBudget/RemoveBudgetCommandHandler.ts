import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { NoBudgetException } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RemoveBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveBudget/RemoveBudgetCommandEvent';

/**
 * Removing a budget: a signed-in member of a group who is its owner removes the budget of a category, which then has none
 * (request 24). To anyone who is not a member the group does not exist; a category with no budget to remove is refused, and
 * so is any other member. The months it passed are kept. Saved, and what it recorded published, in one transaction. Its answer
 * is the budget's id.
 */
export class RemoveBudgetCommandHandler extends CommandHandler<RemoveBudgetCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private budgets: IBudgetRepository,
  ) {
    super();
  }

  async execute(event: RemoveBudgetCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const remover = caller.data.value;

    const { groupId, category } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, remover);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (await this.groupMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    const budget = await this.budgets.findFor(groupId, category);
    if (!budget) return Result.fail(new NoBudgetException());

    const removed = budget.unset({ removedBy: remover, members });
    if (removed.isFailure()) return Result.fail(removed.error);

    const saved = await this.budgets.save(removed.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(removed.data, context);
    return Result.ok(removed.data._id.value);
  }
}
