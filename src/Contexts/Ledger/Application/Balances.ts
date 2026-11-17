import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { IExpenseStore, MemberBalanceView } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { GroupNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * Every member's balance in a group, in the order they joined, the earliest first (request 5, the storm's `GetGroupBalances`):
 * what each paid for the group's expenses, less their shares, a member with nothing recorded at 0. The members and their order
 * are read through the owned port (who is in the group, in join order); the sums are the store's read model. The group is read
 * by its members only: a caller who is not one of them gets the group's `404`, the same as for a group that does not exist.
 */
export const getGroupBalances = query(
  'GetGroupBalances',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async (groupId: string, context): Promise<IResult<MemberBalanceView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }

      const counted = new Map((await expenses.balancesOf(groupId)).map(row => [row.memberId, row.balance]));
      return Result.ok(members.map(({ memberId }) => ({ memberId, balance: counted.get(memberId) ?? 0 })));
    },
);
