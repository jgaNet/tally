import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';

/**
 * A member of a group creates an invitation to it: the operation answers the invitation's id, which is the link. Only
 * a member may: for anyone else the group does not exist, the same refusal as one that is not there.
 */
export class CreateInvitationCommandHandler extends CommandHandler<CreateInvitationCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private invitations: IInvitationRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: CreateInvitationCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.isMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: payload.groupId }));
    }

    const invitation = Invitation.issue({ groupId: group._id, invitedBy: caller.data, now: this.clock() });
    const saved = await this.invitations.save(invitation);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(invitation, context);
    return Result.ok(invitation._id.value);
  }
}
