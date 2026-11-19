import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * The accounts among these that are not deleted, in the order given (request 35, docs/adr/0035). A deleted account stays a member, at its
 * place and with its balance, but it is in no new split, starts no recurring expense and is told of no budget: each of those is asked
 * the members through this, so that a deleted account is left out of what it is given. Ids in, ids out.
 */
export async function notDeletedAmong(groupMembers: IGroupMembers, memberIds: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const memberId of memberIds) {
    if (!(await groupMembers.isDeleted(memberId))) kept.push(memberId);
  }
  return kept;
}
