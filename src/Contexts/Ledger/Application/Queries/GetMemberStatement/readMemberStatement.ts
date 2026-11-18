import { IResult, NotFoundException, Result } from '@Architecture/Domain';

import {
  IStatementQueries,
  MemberStatement,
  SettlementRow,
  StatementEntry,
  StatementRow,
} from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';

/** The ports a member's statement is read through: Ledger's read model of expenses, Groups' membership, Settlements' counted settlements. */
export interface StatementReaders {
  statements: IStatementQueries;
  groupMembers: IGroupMembers;
  settledAmounts: ISettledAmounts;
}

const DESCRIPTIONS = {
  cash: 'Settlement in cash',
  provider: 'Settlement through the provider',
  net: 'Settlement by netting',
} as const;

/** The day, in UTC, of an instant (ISO, as the clock gave it). */
const dayOf = (at: string): string => new Date(at).toISOString().slice(0, 10);

/**
 * A member's statement, as the members of the group read it (requests 8, 9, 29): the expenses the member paid or is in the split
 * of, and the settlements the balances count that the member paid or received, in the order of a bank statement: the earliest date
 * first, then the earliest instant (an expense by when it was recorded, a settlement by when the balances started to count it; an
 * expense first at a tie). Each entry carries the balance once it is counted, from 0; the statement's balance is the last entry's.
 * To anyone who is not a member the group does not exist; a member the group has never had does not exist either, while a former
 * member's statement is read as it was. Membership is asked of Groups, through its port.
 */
export async function readMemberStatement(
  { statements, groupMembers, settledAmounts }: StatementReaders,
  { groupId, memberId }: { groupId: string; memberId: string },
  askedBy: string,
): Promise<IResult<MemberStatement>> {
  const members = await groupMembers.membersOf(groupId, askedBy);
  if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
  const current = members.some(member => member.memberId === memberId);
  if (!current && !(await groupMembers.hasBeenMember(groupId, memberId, askedBy))) {
    return Result.fail(new NotFoundException('Ledger', 'Member not found'));
  }

  const settlements: SettlementRow[] = (await settledAmounts.countedOf(groupId, memberId)).map(settlement => ({
    kind: 'settlement',
    settlementId: settlement.settlementId,
    date: dayOf(settlement.countedAt),
    description: DESCRIPTIONS[settlement.method],
    paid: settlement.from === memberId ? settlement.amount : 0,
    share: settlement.to === memberId ? settlement.amount : 0,
    at: settlement.countedAt,
  }));
  const rows: StatementRow[] = [...(await statements.expenseRowsOf(groupId, memberId)), ...settlements].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );

  let balance = 0;
  const entries: StatementEntry[] = rows.map(row => {
    balance += row.paid - row.share;
    return entryOf(row, balance);
  });
  return Result.ok({ memberId, balance, entries });
}

/** An entry of a row: the row's fields without the instant that ordered it, and the balance once counted. */
function entryOf(row: StatementRow, balance: number): StatementEntry {
  return row.kind === 'expense'
    ? {
        kind: 'expense',
        expenseId: row.expenseId,
        date: row.date,
        description: row.description,
        paid: row.paid,
        share: row.share,
        balance,
      }
    : {
        kind: 'settlement',
        settlementId: row.settlementId,
        date: row.date,
        description: row.description,
        paid: row.paid,
        share: row.share,
        balance,
      };
}
