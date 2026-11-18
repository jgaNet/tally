import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';

/**
 * A member of a group creates an invitation to it; the result is the invitation's id, the link. Anyone else gets the
 * answer for a group that does not exist: the group is not theirs to see.
 */
export class CreateInvitationCommandHandler extends CommandHandler<CreateInvitationCommandEvent> {
  constructor(
    private readonly groups: IGroupRepository,
    private readonly invitations: IInvitationRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: CreateInvitationCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string }>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.hasMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found'));
    }

    const open = group.mayChange();
    if (open.isFailure()) return open;

    const invitation = Invitation.issue({ groupId: group._id, invitedBy: caller.data, at: this.clock() });
    const saved = await this.invitations.save(invitation);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(invitation, context);
    return Result.ok({ id: invitation._id.value });
  }
}
