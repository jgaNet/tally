import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate/SaveTemplateCommandEvent';

/**
 * Saving a split template (request 25): a signed-in member of a group saves a split under a name. To anyone who is not a member the
 * group does not exist. The name is free in the group, whatever its case, and the split is the group's members, each listed once,
 * each with at least one share; a refusal is a failed Result by name. Saved, and what it recorded published, in one transaction.
 * Its answer is the template's id.
 */
export class SaveTemplateCommandHandler extends CommandHandler<SaveTemplateCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private templates: ISplitTemplateRepository,
  ) {
    super();
  }

  async execute(event: SaveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const saver = caller.data.value;

    const { groupId, name, split } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, saver);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (await this.groupMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    const taken = await this.templates.findByName(groupId, name);

    const saved = SplitTemplate.draft({ groupId, name, split, savedBy: saver, members, nameTaken: taken !== null });
    if (saved.isFailure()) return Result.fail(saved.error);

    const stored = await this.templates.save(saved.data);
    if (stored.isFailure()) return Result.fail(stored.error);

    await this.publishDomainEvents(saved.data, context);
    return Result.ok(saved.data._id.value);
  }
}
