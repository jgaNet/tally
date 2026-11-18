import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SaveTemplateCommandEvent } from '@Contexts/Ledger/Application/Commands/SaveTemplate/SaveTemplateCommandEvent';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * A signed-in member of a group saves a split under a name (request 25). For anyone who is not a member the group does not exist. The
 * members of the split are read from Groups through the port Ledger owns (ADR 3), and the name is free in the group, whatever its case.
 * The operation answers the template's id.
 */
export class SaveTemplateCommandHandler extends CommandHandler<SaveTemplateCommandEvent> {
  constructor(
    private templates: ISplitTemplateRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: SaveTemplateCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const members = await this.groupMembers.membersOf(payload.groupId);
    if (!members.some(member => member.value === caller.data.value)) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));
    }

    const groupId = new Id(payload.groupId);
    const saved = SplitTemplate.register({
      groupId,
      createdBy: caller.data,
      name: payload.name,
      split: payload.split,
      groupMembers: members,
      nameTaken: await this.templates.nameTaken(groupId, payload.name, null),
    });
    if (saved.isFailure()) return saved;

    const stored = await this.templates.save(saved.data);
    if (stored.isFailure()) return stored;

    await this.publishDomainEvents(saved.data, context);
    return Result.ok(saved.data._id.value);
  }
}
