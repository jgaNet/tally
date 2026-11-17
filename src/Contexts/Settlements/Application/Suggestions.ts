import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore } from '@Contexts/Settlements/Application/ISettlementStore';
import { openBook } from '@Contexts/Settlements/Application/OpenBook';
import { GroupNotFoundException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { Transfer, suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/**
 * The transfers that would bring every balance of the group to 0, in the order made (request 11, the storm's `GetSuggestedSettlements`).
 * The members are read in the order they joined, and their balances from Ledger's read model through the owned ports, with the payments
 * waiting at the provider counted as paid (request 13): what is still owed is what the suggestion brings to 0. The suggestion is computed
 * here, at the read, and recorded nowhere: it changes no balance and publishes no fact. The group is read by its members only: a caller
 * who is not one of them gets the group's `404`, the same as for a group that does not exist.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (store: ISettlementStore, members: ISettlementMembers, balances: IGroupBalances) =>
    async (groupId: string, context): Promise<IResult<Transfer[]>> => {
      const book = await openBook(store, members, balances, groupId);
      if (!book || !book.hasMember(callerOf(context))) return Result.fail(new GroupNotFoundException());
      return Result.ok(suggestSettlements(book.stillOwed()));
    },
);
