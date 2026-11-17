import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandEvent';

/**
 * Joining a group by an invitation: a signed-in person who holds the link becomes a member of the group, once. The
 * invitation says which group; the group decides whether the caller may join it (it refuses one already a member),
 * and is saved with what it recorded, MemberJoined, in one transaction. The invitation itself changes nothing. The
 * answer is the group's id. The clock is the application's, passed by the wiring.
 */
export class AcceptInvitationCommandHandler extends CommandHandler<AcceptInvitationCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private invitations: IInvitationRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: AcceptInvitationCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const invitation = await this.invitations.findById(event.payload.invitationId);
    if (!invitation) return Result.fail(new NotFoundException('Groups', 'Invitation not found'));

    const group = await this.groups.findById(invitation.groupId);
    if (!group) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const joined = group.join({ accountId: caller.data.value, joinedAt: this.clock() });
    if (joined.isFailure()) return Result.fail(joined.error);

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}
