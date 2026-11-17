import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { ExpenseView, IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { GroupNotFoundException, StatementNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** One line of a statement as a member reads it: the expense, what the member paid for it and their share, and their balance after it. */
export interface StatementEntryView {
  readonly expenseId: string;
  readonly date: string;
  readonly description: string;
  readonly paid: number;
  readonly share: number;
  readonly balance: number;
}

/** A member's statement (request 8): the lines in the order of a bank statement, and the balance the last line leaves. */
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
 * A member's statement (request 8, the storm's `GetMemberStatement`): every expense that is not deleted and that the member paid
 * or is in the split of, the earliest date first and, on the same date, the earliest recorded first. Each entry's balance is the
 * running sum of what the member paid less their share, counted here, at the read, from 0 (a statement's balance is the last
 * entry's, or 0 with none, and it is the one the group's balances give the member). Read by the group's members only (`404` to
 * anyone else, as for a group that does not exist); a member who has never been a member of the group has no statement (`404`).
 */
export const getMemberStatement = query(
  'GetMemberStatement',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async ({ groupId, memberId }: MemberStatementInput, context): Promise<IResult<MemberStatementView>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }
      if (!members.some(member => member.memberId === memberId)) {
        return Result.fail(new StatementNotFoundException());
      }

      let balance = 0;
      const entries = (await expenses.statementRowsOf(groupId, memberId)).map(row => {
        balance += row.paid - row.share;
        return { ...row, balance };
      });
      return Result.ok({ memberId, balance, entries });
    },
);
