import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { NotFoundException, Result } from '@Architecture/Domain';

import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { stillBalance } from '@Contexts/Settlements/Domain/Settlement/StillOwed';
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
 *
 * What is waiting at the provider counts as if it were paid (request 13, docs/adr/0014): each balance is what the member still owes
 * or is still owed once its pending settlements are counted, so a suggestion never asks for a transfer already on its way.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (balances: IGroupBalances, members: ISettlementMembers, settlements: ISettlementQueries) =>
    async ({ groupId }: { groupId: string }, context) => {
      const recorded = await balances.balancesOf(groupId);
      const group = await members.groupOf(callerOf(context), groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));
      const waiting = await settlements.waitingOf(groupId);

      const owed = new Map(recorded.map(({ memberId, balance }) => [memberId, balance]));
      const pending = new Map(waiting.map(({ memberId, paid, received }) => [memberId, { paid, received }]));
      return Result.ok(
        suggestTransfers(
          group.members.map(({ memberId }) => ({
            memberId,
            balance: stillBalance(owed.get(memberId) ?? 0, pending.get(memberId) ?? { paid: 0, received: 0 }),
          })),
        ),
      );
    },
);
