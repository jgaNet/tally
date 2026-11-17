import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';

/** A member lists the group's members in the order they joined. For anyone else the group does not exist. */
export class GetGroupMembersQueryHandler extends QueryHandler<
  IGroupQueries,
  { id: string },
  IResult<MemberReadModel[]>
> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<MemberReadModel[]>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;
    const group = await this.queries.findForMember(id, caller.data.value);
    if (!group) return Result.fail(new NotFoundException('Groups', 'Group not found'));
    return Result.ok(await this.queries.listMembers(group.id));
  }
}
