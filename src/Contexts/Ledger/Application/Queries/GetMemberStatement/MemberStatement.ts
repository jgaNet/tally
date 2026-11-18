import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/Ports/ISettledAmounts';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { StatementEntryReadModel, StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** How a settlement the balances count is named in a statement, by how it was paid (requests 12, 13, 32). */
const DESCRIPTIONS: Record<'cash' | 'provider' | 'net', string> = {
  cash: 'Settlement in cash',
  provider: 'Settlement through the provider',
  net: 'Settlement by netting',
};

/** The ports a member's statement is read through: the group's members, the expenses' audit (when each was recorded), and the settlements. */
export interface StatementSources {
  groupMembers: IGroupMembers;
  audit: IAuditQueries;
  settled: ISettledAmounts;
}

/**
 * A member's statement (requests 8 and 29), read for a signed-in caller who is a member of the group: every expense that has not been
 * deleted and that the member paid or is in the split of, and every settlement the balances count that the member pays or receives,
 * in the order of a bank statement. The date is the day a line is listed under, the earliest first; on the same date the earliest first,
 * an expense by when it was recorded (its audit entry, ADR 20) and a settlement by when the balances started to count it. An expense
 * recorded before the audit kept that moment is listed first on its day, in the order it was recorded. Each entry carries what the
 * member paid, their share, and their running balance from 0. Nothing is stored per entry: the statement is counted here, at the read.
 */
export async function readMemberStatement(
  expenses: IExpenseQueries,
  sources: StatementSources,
  groupId: string,
  memberId: string,
  callerId: Id,
): Promise<IResult<StatementReadModel>> {
  if (!(await sources.groupMembers.isMember(groupId, callerId))) {
    return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
  }
  // A former member's statement is still read: a member who left is one the group has had (ADR 4).
  if (!(await sources.groupMembers.hasBeenMember(groupId, new Id(memberId)))) {
    return Result.fail(new NotFoundException('Ledger', 'Member not found', { id: memberId }));
  }

  // Recorded order, the earliest first: the index is the recording order the same-date sort reads for an expense without a moment.
  const recorded = await expenses.ofGroup(groupId);
  const recordedAt = new Map(
    (await sources.audit.entriesOf(groupId))
      .filter(entry => entry.action === 'expense-recorded')
      .map(entry => [entry.subjectId, Date.parse(entry.at)]),
  );
  const counted = await sources.settled.countedOf(groupId, memberId);

  const lines: Timed[] = [
    ...recorded
      .filter(expense => involves(expense, memberId))
      .map(expense => ({
        date: expense.date,
        at: recordedAt.get(expense.id) ?? Number.NEGATIVE_INFINITY,
        entry: expenseEntry(expense, memberId),
      })),
    ...counted.map(settlement => {
      const at = Date.parse(settlement.countedFrom);
      const payer = settlement.payer === memberId;
      return {
        date: settlement.countedFrom.slice(0, 10),
        at,
        entry: {
          kind: 'settlement' as const,
          settlementId: settlement.settlementId,
          date: settlement.countedFrom.slice(0, 10),
          description: DESCRIPTIONS[settlement.method],
          paid: payer ? settlement.amount : 0,
          share: payer ? 0 : settlement.amount,
          balance: 0,
        },
      };
    }),
  ];
  // A stable sort: an expense and a settlement that are equal on the date and the moment keep the order they were listed in, expenses first.
  lines.sort((a, b) => compare(a.date, b.date) || compare(a.at, b.at));

  let balance = 0;
  const entries: StatementEntryReadModel[] = lines.map(({ entry }) => {
    balance += entry.paid - entry.share;
    return { ...entry, balance };
  });
  return Result.ok({ memberId, balance, entries });
}

interface Timed {
  date: string;
  at: number;
  entry: StatementEntryReadModel;
}

const expenseEntry = (expense: ExpenseReadModel, memberId: string): StatementEntryReadModel => ({
  kind: 'expense',
  expenseId: expense.id,
  date: expense.date,
  description: expense.description,
  paid: expense.paidBy === memberId ? expense.amount : 0,
  share: expense.shares.find(s => s.memberId === memberId)?.amount ?? 0,
  balance: 0,
});

const involves = (expense: ExpenseReadModel, memberId: string): boolean =>
  expense.paidBy === memberId || expense.shares.some(share => share.memberId === memberId);

const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);
