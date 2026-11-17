import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementQueries, SettlementView } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * A signed-in member of a group lists its settlements, each as it reads on its own with every status it has had, the most recently
 * recorded first (request 19). A settlement stays the group's after its payer or payee has left, so the list is the group's whole
 * book, whoever of its current members asks. To anyone who is not a current member the group does not exist. The members are asked
 * of Groups through the port Settlements owns; the settlements are read from Settlements' own read model.
 */
export class GetGroupSettlementsQueryHandler extends QueryHandler<
  ISettlementQueries,
  { groupId: string },
  IResult<SettlementView[]>
> {
  constructor(
    queries: ISettlementQueries,
    private settlementMembers: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<SettlementView[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.settlementMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));

    return Result.ok(await this.queries.listGroupSettlements(groupId));
  }
}
