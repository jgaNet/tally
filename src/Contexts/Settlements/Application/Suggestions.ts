import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { GroupNotFoundException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { Transfer, suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/**
 * The transfers that would bring every balance of the group to 0, in the order made (request 11, the storm's
 * `GetSuggestedSettlements`). The members are read in the order they joined, and their balances from Ledger's read model through
 * the owned ports; a member nothing has counted is at 0. The suggestion is computed here, at the read, and recorded nowhere: it
 * changes no balance and publishes no fact. The group is read by its members only: a caller who is not one of them gets the
 * group's `404`, the same as for a group that does not exist.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (members: ISettlementMembers, balances: IGroupBalances) =>
    async (groupId: string, context): Promise<IResult<Transfer[]>> => {
      const memberIds = await members.membersOf(groupId);
      if (!memberIds || !memberIds.some(memberId => memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }

      const counted = new Map((await balances.balancesOf(groupId)).map(row => [row.memberId, row.balance]));
      const inJoinOrder = memberIds.map(memberId => ({ memberId, balance: counted.get(memberId) ?? 0 }));
      return Result.ok(suggestSettlements(inJoinOrder));
    },
);
