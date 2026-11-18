import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SetBudgetCommandEvent } from '@Contexts/Ledger/Application/Commands/SetBudget/SetBudgetCommandEvent';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * The signed-in owner of a group sets its monthly budget for a category; setting it again replaces it, and it makes no notice by
 * itself. For anyone who is not a member the group does not exist; a member who is not the owner is refused by the budget. The role
 * is read from Groups through the port Ledger owns (ADR 3). The operation answers the budget's id.
 */
export class SetBudgetCommandHandler extends CommandHandler<SetBudgetCommandEvent> {
  constructor(
    private budgets: IBudgetRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: SetBudgetCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const role = await this.groupMembers.roleOf(payload.groupId, caller.data);
    if (!role) return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));

    const category = Category.create(payload.category);
    if (category.isFailure()) return category;

    const groupId = new Id(payload.groupId);
    const existing = await this.budgets.findByGroupAndCategory(groupId, category.data.value);
    const set = existing
      ? existing.replace({ amount: payload.amount, byOwner: role === 'owner' })
      : Budget.set({ groupId, category: category.data.value, amount: payload.amount, byOwner: role === 'owner' });
    if (set.isFailure()) return set;

    const saved = await this.budgets.save(set.data);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(set.data, context);
    return Result.ok(set.data._id.value);
  }
}
