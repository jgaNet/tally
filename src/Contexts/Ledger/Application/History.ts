import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { ExpenseView, IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { CountedSettlement, ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { GroupNotFoundException, StatementNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What both kinds of statement line say: the day, what it is, what the member paid and their share of it, and their balance after it. */
interface StatementLineBase {
  readonly date: string;
  readonly description: string;
  readonly paid: number;
  readonly share: number;
  readonly balance: number;
}

/** A statement line of an expense (request 8): the expense it is, as its `expenseId`. */
export interface ExpenseStatementEntryView extends StatementLineBase {
  readonly kind: 'expense';
  readonly expenseId: string;
}

/** A statement line of a settlement the balances count (request 29): the settlement it is, as its `settlementId`. */
export interface SettlementStatementEntryView extends StatementLineBase {
  readonly kind: 'settlement';
  readonly settlementId: string;
}

/** One line of a statement as a member reads it: an expense or a settlement, what the member paid and their share, and their balance after it. */
export type StatementEntryView = ExpenseStatementEntryView | SettlementStatementEntryView;

/** A member's statement (requests 8 and 29): the lines in the order of a bank statement, and the balance the last line leaves. */
export interface MemberStatementView {
  readonly memberId: string;
  readonly balance: number;
  readonly entries: readonly StatementEntryView[];
}

/** The statement's question: whose it is, in which group. */
export interface MemberStatementInput {
  readonly groupId: string;
  readonly memberId: string;
}

/**
 * Every expense of a group that is not deleted, as each reads on its own (request 8, the storm's `GetGroupExpenses`): the latest
 * date first and, on the same date, the most recently recorded first. Read by the group's members only: a caller who is not one
 * of them gets the group's `404`, the same as for a group that does not exist.
 */
export const getGroupExpenses = query(
  'GetGroupExpenses',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async (groupId: string, context): Promise<IResult<ExpenseView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }
      return Result.ok(await expenses.listOf(groupId));
    },
);

/**
 * A member's statement (request 8, the storm's `GetMemberStatement`; request 29 adds the settlements): every expense that is not deleted
 * and that the member paid or is in the split of, and every settlement the balances count that the member paid or received. The lines are
 * ordered by their date, the earliest first and, on the same date, by when they happened: an expense by when it was recorded, a settlement by
 * when the balances started to count it. Each line's balance is the running sum of what the member paid less their share, counted here, at
 * the read, from 0 (a statement's balance is the last line's, or 0 with none). Read by the group's members only (`404` to anyone else, as for a
 * group that does not exist); a member who has never been a member of the group has no statement (`404`).
 */
export const getMemberStatement = query(
  'GetMemberStatement',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, settled: ISettledAmounts) =>
    async (input: MemberStatementInput, context): Promise<IResult<MemberStatementView>> =>
      statementOf(expenses, groupMembers, settled, input, context),
);

/**
 * The same statement (request 29, the storm's `GetMemberStatementCsv`): the read model `GetMemberStatement` answers, asked by the route
 * that renders it as CSV, so the rendering is the transport's and the query's answer is the statement's. Read by the same members, and
 * refused the same way.
 */
export const getMemberStatementCsv = query(
  'GetMemberStatementCsv',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, settled: ISettledAmounts) =>
    async (input: MemberStatementInput, context): Promise<IResult<MemberStatementView>> =>
      statementOf(expenses, groupMembers, settled, input, context),
);

/** A statement line before its balance is counted: the balance is the running sum, counted once the lines are in order. */
type UnbalancedLine = Omit<ExpenseStatementEntryView, 'balance'> | Omit<SettlementStatementEntryView, 'balance'>;

/** The statement's reading, shared by both queries: the membership rules, the lines of both kinds, ordered and balanced. */
async function statementOf(
  expenses: IExpenseStore,
  groupMembers: IGroupMembers,
  settled: ISettledAmounts,
  { groupId, memberId }: MemberStatementInput,
  context: ExecutionContext,
): Promise<IResult<MemberStatementView>> {
  const members = await groupMembers.membersOf(groupId);
  if (!members || !members.some(member => member.memberId === callerOf(context))) {
    return Result.fail(new GroupNotFoundException());
  }
  if (!members.some(member => member.memberId === memberId) && !(await groupMembers.hasBeenMember(groupId, memberId))) {
    return Result.fail(new StatementNotFoundException());
  }

  const lines: { readonly at: number; readonly line: UnbalancedLine }[] = [
    ...(await expenses.statementRowsOf(groupId, memberId)).map(row => ({
      at: Date.parse(row.recordedAt),
      line: {
        kind: 'expense' as const,
        expenseId: row.expenseId,
        date: row.date,
        description: row.description,
        paid: row.paid,
        share: row.share,
      },
    })),
    ...(await settled.countedOf(groupId, memberId)).map(settlement => ({
      at: Date.parse(settlement.countedFrom),
      line: settlementLine(settlement, memberId),
    })),
  ];
  // Stable: lines that are the same date and instant keep the order they were read in, expenses first.
  lines.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : a.at - b.at));

  let balance = 0;
  const entries = lines.map(({ line }): StatementEntryView => {
    balance += line.paid - line.share;
    return { ...line, balance };
  });
  return Result.ok({ memberId, balance, entries });
}

/** A settlement the balances count, as a statement line of the member: what they paid or were paid, on the day it started to count. */
function settlementLine(settlement: CountedSettlement, memberId: string): UnbalancedLine {
  return {
    kind: 'settlement',
    settlementId: settlement.settlementId,
    date: new Date(settlement.countedFrom).toISOString().slice(0, 10),
    description: settlement.method === 'cash' ? 'Settlement in cash' : 'Settlement through the provider',
    paid: settlement.from === memberId ? settlement.amount : 0,
    share: settlement.to === memberId ? settlement.amount : 0,
  };
}
