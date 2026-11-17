import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementQueries, SettlementView } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * A signed-in member of a settlement's group reads the settlement: its payer, payee, amount, how it was paid and when it was
 * recorded (request 12). To anyone who is not a member of its group, the settlement does not exist.
 */
export class GetSettlementQueryHandler extends QueryHandler<
  ISettlementQueries,
  { id: string },
  IResult<SettlementView>
> {
  constructor(
    queries: ISettlementQueries,
    private settlementMembers: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<SettlementView>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);

    const settlement = await this.queries.findById(id);
    if (!settlement) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const members = await this.settlementMembers.membersOf(settlement.groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));
    return Result.ok(settlement);
  }
}
