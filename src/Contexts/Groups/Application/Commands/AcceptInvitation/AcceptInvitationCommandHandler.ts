import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandEvent';

/**
 * A signed-in person accepts an invitation: they join the group it is to, as its newest member, once. The invitation is
 * read, not changed; the group is the one that changes. A concurrent join is re-read and re-decided by the handler's
 * retry, so two people joining at once both end up members.
 */
export class AcceptInvitationCommandHandler extends CommandHandler<AcceptInvitationCommandEvent> {
  constructor(
    private invitations: IInvitationRepository,
    private groups: IGroupRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: AcceptInvitationCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const invitation = await this.invitations.findById(new Id(payload.invitationId));
    if (!invitation) {
      return Result.fail(new NotFoundException('Groups', 'Invitation not found', { id: payload.invitationId }));
    }

    const group = await this.groups.findById(invitation.groupId);
    if (!group) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: invitation.groupId.value }));
    }

    const joined = group.join({ accountId: caller.data, now: this.clock() });
    if (joined.isFailure()) return joined;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(group, context);
    return Result.ok();
  }
}
