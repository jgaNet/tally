import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { NotFoundException, Result } from '@Architecture/Domain';

import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';
import { IAuditQueries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditQueries';
import { IPassedBalances } from '@Contexts/Ledger/Domain/Audit/Ports/IPassedBalances';
import { ISettlementAudit } from '@Contexts/Ledger/Domain/Audit/Ports/ISettlementAudit';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A group's audit, for its members only: every change of money in it, the oldest first (request 28, docs/adr/0027). The expenses' entries
 * are Ledger's own; the settlements' and the balances that passed are read through the ports Ledger owns, each over the other context's
 * read model. The three are merged by the time of the change. For anyone else the group does not exist.
 */
export const getGroupAudit = query(
  'GetGroupAudit',
  (audit: IAuditQueries, settlements: ISettlementAudit, passed: IPassedBalances, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const entries: AuditEntryView[] = [
        ...(await audit.entriesOf(groupId)),
        ...(await settlements.entriesOf(groupId)),
        ...(await passed.entriesOf(groupId)),
      ];
      // Each source is read oldest first, and the sort is stable: on the same instant, the expenses' entries come first.
      return Result.ok(entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
    },
);
