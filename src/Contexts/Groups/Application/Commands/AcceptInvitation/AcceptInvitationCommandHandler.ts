import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandEvent';

/**
 * A signed-in person accepts an invitation: they join the group it leads to, with the same rights as every member.
 * Whoever holds the link may ask; the group decides whether this account may join (once, and only once).
 */
export class AcceptInvitationCommandHandler extends CommandHandler<AcceptInvitationCommandEvent> {
  constructor(
    private readonly invitations: IInvitationRepository,
    private readonly groups: IGroupRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: AcceptInvitationCommandEvent, context: ExecutionContext): Promise<IResult<undefined>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const invitation = await this.invitations.findById(new Id(payload.invitationId));
    if (!invitation) return Result.fail(new NotFoundException('Groups', 'Invitation not found'));
    const group = await this.groups.findById(invitation.groupId);
    if (!group) return Result.fail(new NotFoundException('Groups', 'Invitation not found'));

    const joined = group.join(caller.data, this.clock());
    if (joined.isFailure()) return joined;
    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(group, context);
    return Result.ok(undefined);
  }
}
