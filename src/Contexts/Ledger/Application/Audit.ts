import { NotFoundException, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

import { IAuditEntries } from './IAuditEntries';
import { IGroupMembers } from './IGroupMembers';
import { IPassedBalances } from './IPassedBalances';
import { ISettlementAudit } from './ISettlementAudit';

/**
 * A member of a group reads its audit, every change of money in it, the oldest first (request 28): the expenses Ledger recorded, edited and
 * deleted, the settlements Settlements counts as paid or refunded, and the balances that passed to the owner when a member left, the ones
 * of nothing left out. Each context keeps its own entries in the transaction of its change (ADR 25); this query reads them through the three
 * ports it owns and puts them in the order they were made. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getGroupAudit = query(
  'GetGroupAudit',
  (groupMembers: IGroupMembers, ownEntries: IAuditEntries, settlements: ISettlementAudit, passes: IPassedBalances) =>
    async ({ id }: { id: string }, context) => {
      if (!(await groupMembers.membersOf(id, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      }
      const passed: AuditEntry[] = (await passes.passedOf(id))
        .filter(pass => pass.amount !== 0)
        .map(pass => ({
          id: pass.id,
          at: pass.at,
          by: pass.memberId,
          action: 'balance-passed',
          subjectId: pass.memberId,
          amount: pass.amount,
        }));
      const entries = [...(await ownEntries.auditOf(id)), ...(await settlements.auditOf(id)), ...passed];
      return Result.ok(oldestFirst(entries));
    },
);

/**
 * The entries in the order they were made: by `at`, and on the same instant in the order they were listed, the expenses' own first. A stable
 * sort, so the entries of one context keep the order it wrote them in.
 */
const oldestFirst = (entries: AuditEntry[]): AuditEntry[] =>
  [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
