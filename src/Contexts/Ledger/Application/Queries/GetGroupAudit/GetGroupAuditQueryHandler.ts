import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { ISettlementAudit } from '@Contexts/Ledger/Application/Ports/ISettlementAudit';
import { IPassedBalances } from '@Contexts/Ledger/Application/Ports/IPassedBalances';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * A member of the group reads its audit: every change of money in it, the oldest first. The entries of the expenses are
 * Ledger's own; those of the settlements and of the balances that passed are asked of Settlements and of Groups, through the
 * ports Ledger owns. For anyone who is not a member the group does not exist.
 */
export class GetGroupAuditQueryHandler extends QueryHandler<
  IAuditQueries,
  { groupId: string },
  IResult<AuditEntryReadModel[]>
> {
  constructor(
    queries: IAuditQueries,
    private readonly settlements: ISettlementAudit,
    private readonly passedBalances: IPassedBalances,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<AuditEntryReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const members = await this.groupMembers.currentMembers(new Id(groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    const entries = [
      ...(await this.queries.listByGroup(groupId)),
      ...(await this.settlements.entriesOf(groupId)),
      ...(await this.passedBalances.entriesOf(groupId)),
    ];
    // Every time is an ISO string in UTC, so the strings order as the instants do.
    return Result.ok(entries.sort((earlier, later) => (earlier.at < later.at ? -1 : earlier.at > later.at ? 1 : 0)));
  }
}
