import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate/ReplaceTemplateCommandEvent';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * A signed-in member of a template's group replaces it: the member who saved it or the group's owner may, and the template decides
 * which of them. For anyone who is not a member the template does not exist. The operation answers the template's id.
 */
export class ReplaceTemplateCommandHandler extends CommandHandler<ReplaceTemplateCommandEvent> {
  constructor(
    private templates: ISplitTemplateRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: ReplaceTemplateCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const template = await this.templates.findById(new Id(payload.templateId));
    if (!template) return Result.fail(notFound(payload.templateId));
    const role = await this.groupMembers.roleOf(template.groupId.value, caller.data);
    if (!role) return Result.fail(notFound(payload.templateId));

    const replaced = template.replaceWith({
      by: caller.data,
      byOwner: role === 'owner',
      archived: await this.groupMembers.archivedOf(template.groupId.value),
      name: payload.name,
      split: payload.split,
      groupMembers: await this.groupMembers.membersOf(template.groupId.value),
      nameTaken: await this.templates.nameTaken(template.groupId, payload.name, template._id),
    });
    if (replaced.isFailure()) return replaced;

    const stored = await this.templates.save(replaced.data);
    if (stored.isFailure()) return stored;

    await this.publishDomainEvents(replaced.data, context);
    return Result.ok(template._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Template not found', { id });
