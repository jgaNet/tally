import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate/RemoveTemplateCommandEvent';

/**
 * The member who saved a template, or the owner of its group, removes it. The expenses split by it keep their shares. A
 * member who is not in the group does not see the template at all; any other member is refused by the aggregate.
 */
export class RemoveTemplateCommandHandler extends CommandHandler<RemoveTemplateCommandEvent> {
  constructor(
    private readonly templates: ISplitTemplateRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RemoveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const template = await this.templates.findById(new Id(payload.templateId));
    if (!template) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const role = await this.groupMembers.roleOf(template.groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const groupArchived = await this.groupMembers.isArchived(template.groupId);

    const removed = template.retire({
      by: caller.data,
      byOwner: role === 'owner',
      groupArchived,
      at: this.clock(),
    });
    if (removed.isFailure()) return removed;

    const saved = await this.templates.save(removed.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(removed.data, context);
    return Result.ok();
  }
}
