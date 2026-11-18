import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { templateSplitOf } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { ReplaceTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/ReplaceTemplate/ReplaceTemplateCommandEvent';

/**
 * The member who saved a template, or the owner of its group, replaces it, under the rules of saving. A member who is not
 * in the group does not see the template at all; any other member is refused by the aggregate.
 */
export class ReplaceTemplateCommandHandler extends CommandHandler<ReplaceTemplateCommandEvent> {
  constructor(
    private readonly templates: ISplitTemplateRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ReplaceTemplateCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const template = await this.templates.findById(new Id(payload.templateId));
    if (!template) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const role = await this.groupMembers.roleOf(template.groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Template not found'));
    const groupArchived = await this.groupMembers.isArchived(template.groupId);

    const name = TemplateName.of(payload.name);
    if (name.isFailure()) return name;
    const split = templateSplitOf(payload);
    if (split.isFailure()) return split;
    const sameName = await this.templates.findByName(template.groupId, name.data);

    const replaced = template.revise({
      by: caller.data,
      byOwner: role === 'owner',
      name: name.data,
      split: split.data,
      groupMembers: await this.groupMembers.currentMembers(template.groupId),
      sameNameAs: sameName ? sameName._id : null,
      groupArchived,
      at: this.clock(),
    });
    if (replaced.isFailure()) return replaced;

    const saved = await this.templates.save(replaced.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(replaced.data, context);
    return Result.ok();
  }
}
