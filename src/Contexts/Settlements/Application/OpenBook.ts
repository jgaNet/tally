import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore } from '@Contexts/Settlements/Application/ISettlementStore';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The book of a group as it stands, read the same way for every command and query that decides in it: its version, the members in the
 * order they joined, what the ledger counts for each (a member nothing has counted is 0), and the payments waiting at the provider
 * (request 13). Answers `undefined` when there is no such group.
 */
export async function openBook(
  store: ISettlementStore,
  members: ISettlementMembers,
  balances: IGroupBalances,
  groupId: string,
): Promise<SettlementBook | undefined> {
  const memberIds = await members.membersOf(groupId);
  if (!memberIds) return undefined;
  const counted = new Map((await balances.balancesOf(groupId)).map(row => [row.memberId, row.balance]));
  return SettlementBook.open({
    groupId,
    version: await store.versionOf(groupId),
    members: memberIds,
    balances: memberIds.map(memberId => ({ memberId, balance: counted.get(memberId) ?? 0 })),
    waiting: await store.waitingOf(groupId),
    feePolicy: await store.feePolicyOf(groupId),
  });
}
