import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/** The roster of groups, as Groups gives it to the other contexts (ADR 6): the type the wiring of Ledger is given. */
export type GroupRoster = IGroupRoster;

/**
 * Who may be in a split, and who has which role, answered over Groups' roster (ADR 1 T3, ADR 6): Ledger's port `IGroupMembers`
 * is built on the roster Groups' read model gives, so a member who has just joined can be in a split at once, and no domain
 * imports Groups.
 */
export class GroupMembersFromGroups implements IGroupMembers {
  constructor(private readonly roster: GroupRoster) {}

  membersOf(groupId: string): Promise<GroupMemberRole[] | undefined> {
    return this.roster.membersOf(groupId);
  }
}
