import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate/ReplaceTemplateCommandEvent';

/**
 * Replacing a split template (request 25): the member who saved it, or the group's owner, replaces its name and split under the same
 * rules as saving it. To anyone who is not a member of its group the template does not exist; any other member is refused by the
 * template. The name may keep the template's own name, whatever its case, but no other template's. Saved, and what it recorded
 * published, in one transaction. Its answer is the template's id.
 */
export class ReplaceTemplateCommandHandler extends CommandHandler<ReplaceTemplateCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private templates: ISplitTemplateRepository,
  ) {
    super();
  }

  async execute(event: ReplaceTemplateCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const replacer = caller.data.value;

    const { templateId, name, split } = event.payload;
    const template = await this.templates.findById(templateId);
    if (!template) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const members = await this.groupMembers.membersOf(template.groupId, replacer);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    if (await this.groupMembers.isArchived(template.groupId)) return Result.fail(new GroupArchivedException());
    const taken = await this.templates.findByName(template.groupId, name);

    const replaced = template.replace({
      replacedBy: replacer,
      members,
      name,
      split,
      nameTaken: taken !== null && taken._id.value !== template._id.value,
    });
    if (replaced.isFailure()) return Result.fail(replaced.error);

    const stored = await this.templates.save(replaced.data);
    if (stored.isFailure()) return Result.fail(stored.error);

    await this.publishDomainEvents(replaced.data, context);
    return Result.ok(templateId);
  }
}
