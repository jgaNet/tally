import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { IPassedBalances } from '@Contexts/Ledger/Application/Ports/IPassedBalances';
import { ISettlementAudit } from '@Contexts/Ledger/Application/Ports/ISettlementAudit';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group reads its audit: every change of money, the oldest first (request 28). The expenses' entries are
 * Ledger's own; the settlements' and the balances passed are read through the ports Ledger owns (ADR 19), each written by the context
 * that made the change. For anyone who is not a member the group does not exist.
 */
export class GetGroupAuditQueryHandler extends QueryHandler<
  IAuditQueries,
  { groupId: string },
  IResult<AuditEntryReadModel[]>
> {
  constructor(
    queries: IAuditQueries,
    private settlements: ISettlementAudit,
    private passedBalances: IPassedBalances,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<AuditEntryReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }

    const entries = [
      ...(await this.queries.entriesOf(groupId)),
      ...(await this.settlements.entriesOf(groupId)),
      ...(await this.passedBalances.balancesPassedOf(groupId)),
    ];
    // Each source is in the order it was written; a stable sort by the time of each change keeps the oldest first.
    return Result.ok(entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
  }
}
