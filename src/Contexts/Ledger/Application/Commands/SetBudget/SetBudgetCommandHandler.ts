import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget/SetBudgetCommandEvent';

/**
 * Setting a budget: a signed-in member of a group who is its owner sets the monthly budget of a category, in the group's
 * currency (request 24). Setting it again replaces the amount. To anyone who is not a member the group does not exist; any
 * other member is refused by the budget. Saved, and what it recorded published, in one transaction. Setting a budget makes no
 * notice by itself. Its answer is the budget's id.
 */
export class SetBudgetCommandHandler extends CommandHandler<SetBudgetCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private budgets: IBudgetRepository,
  ) {
    super();
  }

  async execute(event: SetBudgetCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const setter = caller.data.value;

    const { groupId, category, amount } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, setter);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (await this.groupMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());

    const budget = (await this.budgets.findFor(groupId, category)) ?? Budget.create({ groupId, category });
    const set = budget.setAmount({ setBy: setter, members, amount });
    if (set.isFailure()) return Result.fail(set.error);

    const saved = await this.budgets.save(set.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(set.data, context);
    return Result.ok(set.data._id.value);
  }
}
