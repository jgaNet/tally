import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { AuditAction, AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { IAuditQueries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditQueries';
import { ISettlementAudit } from '@Contexts/Ledger/Domain/Audit/Ports/ISettlementAudit';
import { IPassedBalances } from '@Contexts/Ledger/Domain/Audit/Ports/IPassedBalances';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** One entry of a group's audit as a member reads it (request 28). */
export interface AuditView {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}

/**
 * A signed-in member reads the audit of their group: every change of money, each as an entry, the oldest first (request 28).
 * Ledger's entries are read from its own table; the settlements' and the passed balances' are read through the two ports it owns,
 * answered over the other contexts' read models (ADR 19). To anyone who is not a member the group does not exist.
 */
export class GetGroupAuditQueryHandler extends QueryHandler<IAuditQueries, { groupId: string }, IResult<AuditView[]>> {
  constructor(
    queries: IAuditQueries,
    private settlementAudit: ISettlementAudit,
    private passedBalances: IPassedBalances,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<AuditView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const entries: AuditEntry[] = [
      ...(await this.queries.entriesOf(groupId)),
      ...(await this.settlementAudit.entriesOf(groupId)),
      ...(await this.passedBalances.entriesOf(groupId)),
    ];
    // The sort is stable: entries written at the same instant keep the order of the contexts that wrote them.
    const oldestFirst = entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return Result.ok(
      oldestFirst.map(({ id, at, by, action, subjectId, amount }) => ({ id, at, by, action, subjectId, amount })),
    );
  }
}
