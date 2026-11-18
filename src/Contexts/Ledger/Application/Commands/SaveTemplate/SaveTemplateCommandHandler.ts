import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { templateSplitOf } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate/SaveTemplateCommandEvent';

/**
 * A member of a group saves a split under a name. Only a member may save one: for anyone else the group does not exist.
 * The name is free in the group, whatever its case, and the members of the split are members of the group now. The result
 * is the template's id.
 */
export class SaveTemplateCommandHandler extends CommandHandler<SaveTemplateCommandEvent> {
  constructor(
    private readonly templates: ISplitTemplateRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SaveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<{ id: string }>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const groupId = new Id(payload.groupId);
    if ((await this.groupMembers.roleOf(groupId, caller.data)) === null) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    const groupArchived = await this.groupMembers.isArchived(groupId);
    const name = TemplateName.of(payload.name);
    if (name.isFailure()) return name;
    const split = templateSplitOf(payload);
    if (split.isFailure()) return split;
    const sameName = await this.templates.findByName(groupId, name.data);

    const template = SplitTemplate.draft({
      groupId,
      name: name.data,
      split: split.data,
      savedBy: caller.data,
      groupMembers: await this.groupMembers.currentMembers(groupId),
      sameNameAs: sameName ? sameName._id : null,
      groupArchived,
      at: this.clock(),
    });
    if (template.isFailure()) return template;

    const saved = await this.templates.save(template.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(template.data, context);
    return Result.ok({ id: template.data._id.value });
  }
}
