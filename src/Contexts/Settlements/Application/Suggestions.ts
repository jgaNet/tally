import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { NotFoundException, Result } from '@Architecture/Domain';

import { suggestTransfers } from '@Contexts/Settlements/Domain/Suggestion/SuggestedTransfers';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/**
 * The transfers that would bring every balance of a group to 0, in the order made (request 11, docs/adr/0012), for its members only:
 * for anyone else the group does not exist. It reads, records nothing and publishes nothing: a suggestion is not a settlement.
 *
 * The balances are read before the members, as the Ledger's balances are (docs/adr/0005): a member who has left had a balance of 0,
 * so the members read after include every member a non-zero balance counts. Every member is listed with its balance, 0 when none is
 * recorded, in the order they joined, so every member reading the group sees the same transfers.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (balances: IGroupBalances, members: ISettlementMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const recorded = await balances.balancesOf(groupId);
      const listed = await members.membersOf(callerOf(context), groupId);
      if (!listed) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));

      const owed = new Map(recorded.map(({ memberId, balance }) => [memberId, balance]));
      return Result.ok(
        suggestTransfers(listed.map(({ memberId }) => ({ memberId, balance: owed.get(memberId) ?? 0 }))),
      );
    },
);
