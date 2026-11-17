import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IInvitationQueries } from '@Contexts/Groups/Application/Ports/IInvitationQueries';
import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';

/**
 * A signed-in person reads the invitation they hold the link of, before joining. They need not be a member of its group:
 * that is what the link is for.
 */
export class GetInvitationQueryHandler extends QueryHandler<
  IInvitationQueries,
  { id: string },
  IResult<InvitationReadModel>
> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<InvitationReadModel>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const invitation = await this.queries.findById(id);
    if (!invitation) return Result.fail(new NotFoundException('Groups', 'Invitation not found', { id }));
    return Result.ok(invitation);
  }
}
