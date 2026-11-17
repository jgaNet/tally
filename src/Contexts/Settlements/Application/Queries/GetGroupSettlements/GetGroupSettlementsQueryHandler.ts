import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/**
 * A member of the group lists its settlements, the most recently recorded first, each with every status it has had (request
 * 19). The settlements stay the group's after their payer or payee has left: what is read is the group's, and the caller is
 * asked for as a current member. For anyone else the group does not exist.
 */
export class GetGroupSettlementsQueryHandler extends QueryHandler<
  ISettlementQueries,
  { id: string },
  IResult<SettlementReadModel[]>
> {
  constructor(
    settlements: ISettlementQueries,
    private readonly members: ISettlementMembers,
  ) {
    super(settlements);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<SettlementReadModel[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const members = await this.members.currentMembers(id);
    if (!members.includes(caller.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }
    return Result.ok(await this.queries.findByGroup(id));
  }
}
