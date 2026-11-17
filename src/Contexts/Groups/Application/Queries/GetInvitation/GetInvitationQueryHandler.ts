import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IInvitationQueries, InvitationView } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';

/**
 * A signed-in person reads the invitation whose link they hold, before joining: the group and who invited them. The
 * caller need not be a member; the link is what lets them read it. An unknown link is not found.
 */
export class GetInvitationQueryHandler extends QueryHandler<
  IInvitationQueries,
  { id: string },
  IResult<InvitationView>
> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<InvitationView>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const invitation = await this.queries.findInvitation(id);
    if (!invitation) return Result.fail(new NotFoundException('Groups', 'Invitation not found'));

    return Result.ok(invitation);
  }
}
