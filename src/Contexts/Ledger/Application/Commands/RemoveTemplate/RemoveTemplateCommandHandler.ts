import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RemoveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/RemoveTemplate/RemoveTemplateCommandEvent';

/**
 * Removing a split template (request 25): the member who saved it, or the group's owner, removes it, and no other member may. To
 * anyone who is not a member of its group the template does not exist. The expenses it split keep their shares. Deleted, and what
 * it recorded published, in one transaction. Its answer is the template's id.
 */
export class RemoveTemplateCommandHandler extends CommandHandler<RemoveTemplateCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private templates: ISplitTemplateRepository,
  ) {
    super();
  }

  async execute(event: RemoveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const remover = caller.data.value;

    const { templateId } = event.payload;
    const template = await this.templates.findById(templateId);
    if (!template) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const members = await this.groupMembers.membersOf(template.groupId, remover);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Template not found'));

    const removed = template.remove({ removedBy: remover, members });
    if (removed.isFailure()) return Result.fail(removed.error);

    const deleted = await this.templates.erase(removed.data);
    if (deleted.isFailure()) return Result.fail(deleted.error);

    await this.publishDomainEvents(removed.data, context);
    return Result.ok(templateId);
  }
}
