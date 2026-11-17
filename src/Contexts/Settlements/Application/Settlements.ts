import { NotFoundException, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { suggestTransfers, SuggestedTransfer } from '@Contexts/Settlements/Domain/Suggestion/SuggestedTransfers';

import { IGroupBalances } from './IGroupBalances';
import { ISettlementMembers } from './ISettlementMembers';

/**
 * A member of a group reads the transfers that would bring every balance of the group to 0 (request 11), made by the stated
 * algorithm, in the order they are made. Reading them changes nothing and records nothing: the balances are what the
 * expenses make them. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (groupBalances: IGroupBalances, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const memberIds = await members.membersOf(id, callerOf(context));
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));
      const balances = await groupBalances.balancesOf(id);
      const transfers: SuggestedTransfer[] = suggestTransfers(
        memberIds.map(memberId => ({ memberId, balance: balances.get(memberId) ?? 0 })),
      );
      return Result.ok(transfers);
    },
);
