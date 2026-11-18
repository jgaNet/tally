import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate/RemoveTemplateCommandEvent';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * A signed-in member of a template's group removes it: the member who saved it or the group's owner may. For anyone who is not a member
 * the template does not exist. The operation answers the template's id.
 */
export class RemoveTemplateCommandHandler extends CommandHandler<RemoveTemplateCommandEvent> {
  constructor(
    private templates: ISplitTemplateRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: RemoveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const template = await this.templates.findById(new Id(payload.templateId));
    if (!template) return Result.fail(notFound(payload.templateId));
    const role = await this.groupMembers.roleOf(template.groupId.value, caller.data);
    if (!role) return Result.fail(notFound(payload.templateId));

    const removed = template.remove({
      by: caller.data,
      byOwner: role === 'owner',
      archived: await this.groupMembers.archivedOf(template.groupId.value),
    });
    if (removed.isFailure()) return removed;

    const deleted = await this.templates.remove(removed.data);
    if (deleted.isFailure()) return deleted;

    await this.publishDomainEvents(removed.data, context);
    return Result.ok(template._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Template not found', { id });
