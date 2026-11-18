import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { IAuditLog } from '@Contexts/Ledger/Application/IAuditLog';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IPassedBalances } from '@Contexts/Ledger/Application/IPassedBalances';
import { ISettlementAudit } from '@Contexts/Ledger/Application/ISettlementAudit';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { GroupNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** One entry of a group's audit as a member reads it (request 28): the fields the API names, without the group. */
export interface AuditEntryView {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly subjectId: string;
  readonly amount: number;
}

/**
 * The group's audit, as a member of it reads it (request 28, feature 28, ADR 23): every change of money of the group, the oldest first,
 * whichever context wrote it. Ledger's own entries are read from its table; the settlements' and the balances that passed are read through
 * the ports Ledger owns. Read by the group's current members only: to anyone else the group does not exist, the group's `404`.
 */
export const getGroupAudit = query(
  'GetGroupAudit',
  (log: IAuditLog, settlements: ISettlementAudit, passes: IPassedBalances, groupMembers: IGroupMembers) =>
    async (groupId: string, context): Promise<IResult<AuditEntryView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }
      const entries: AuditEntry[] = [
        ...(await log.entriesOf(groupId)),
        ...(await settlements.entriesOf(groupId)),
        ...(await passes.entriesOf(groupId)),
      ];
      // Stable: entries made at the same moment keep the order their contexts answered them in.
      const oldestFirst = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      return Result.ok(
        oldestFirst.map(({ id, at, by, action, subjectId, amount }) => ({ id, at, by, action, subjectId, amount })),
      );
    },
);
