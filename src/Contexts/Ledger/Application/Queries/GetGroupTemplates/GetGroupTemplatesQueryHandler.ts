import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISplitTemplateQueries } from '@Contexts/Ledger/Application/Ports/ISplitTemplateQueries';
import { SplitTemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/SplitTemplateReadModel';

/** A member of a group reads its templates, the earliest saved first. For anyone else the group does not exist. */
export class GetGroupTemplatesQueryHandler extends QueryHandler<
  ISplitTemplateQueries,
  { groupId: string },
  IResult<SplitTemplateReadModel[]>
> {
  constructor(
    queries: ISplitTemplateQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId }: { groupId: string },
    context: ExecutionContext,
  ): Promise<IResult<SplitTemplateReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const role = await this.groupMembers.roleOf(new Id(groupId), caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    return Result.ok(await this.queries.listByGroup(groupId));
  }
}
