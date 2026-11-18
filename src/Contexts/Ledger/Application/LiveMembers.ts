import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * The members of a group who are not deleted (feature 35, request 35): what a recurring expense's sweep and a month's budget judgement read as
 * the members of the group. A deleted account stays a member in every read of the group (`membersOf` answers it, at its place); only these two
 * decisions leave it out: a recurring expense it pays or is in the split of ends on its next day, as when a member has left (request 23), and a
 * month's notice reaches the members who are still there. Answers `undefined` when there is no such group, as `membersOf` does.
 */
export async function liveMembersOf(groups: IGroupMembers, groupId: string): Promise<GroupMemberRole[] | undefined> {
  const members = await groups.membersOf(groupId);
  if (!members) return undefined;
  const live: GroupMemberRole[] = [];
  for (const member of members) {
    if (!(await groups.isDeleted(member.memberId))) live.push(member);
  }
  return live;
}

/** Whether one of the accounts is deleted (feature 35): a new split names none, so a new expense or recurring expense with one is refused. */
export async function anyDeleted(groups: IGroupMembers, memberIds: readonly string[]): Promise<boolean> {
  for (const memberId of memberIds) {
    if (await groups.isDeleted(memberId)) return true;
  }
  return false;
}
