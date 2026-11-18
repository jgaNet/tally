import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';
import { GroupArchivedException } from '@SharedKernel/Domain';

/**
 * Creating an invitation: a signed-in member of a group asks for a link to it. Only a member may; to anyone else the
 * group does not exist, so the answer is the same as for a group that is not there. The invitation is saved and what
 * it recorded is published with the save, in one transaction. Its answer is the invitation's id: the link.
 */
export class CreateInvitationCommandHandler extends CommandHandler<CreateInvitationCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private invitations: IInvitationRepository,
  ) {
    super();
  }

  async execute(event: CreateInvitationCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const group = await this.groups.findById(event.payload.groupId);
    if (!group || !group.isMember(caller.data.value)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found'));
    }
    if (group.isArchived()) return Result.fail(new GroupArchivedException());

    const invitation = Invitation.issue({ groupId: group._id.value, invitedBy: caller.data.value });
    const saved = await this.invitations.save(invitation);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(invitation, context);
    return Result.ok(invitation._id.value);
  }
}
