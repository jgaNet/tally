import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { GroupMemberRole, IGroupMembers, PassedBalance } from '@Contexts/Ledger/Application/IGroupMembers';

/** The roster of groups, as Groups gives it to the other contexts (ADR 6): the type the wiring of Ledger is given. */
export type GroupRoster = IGroupRoster;

/**
 * Who may be in a split, and who has which role, answered over Groups' roster (ADR 1 T3, ADR 6): Ledger's port `IGroupMembers`
 * is built on the roster Groups' read model gives, so a member who has just joined can be in a split at once, and no domain
 * imports Groups. The balances that passed when members left are read over the same roster (request 20, ADR 15).
 */
export class GroupMembersFromGroups implements IGroupMembers {
  constructor(private readonly roster: GroupRoster) {}

  membersOf(groupId: string): Promise<GroupMemberRole[] | undefined> {
    return this.roster.membersOf(groupId);
  }

  hasBeenMember(groupId: string, memberId: string): Promise<boolean> {
    return this.roster.hasBeenMember(groupId, memberId);
  }

  passedBalancesOf(groupId: string): Promise<PassedBalance[]> {
    return this.roster.passedBalancesOf(groupId);
  }

  isArchived(groupId: string): Promise<boolean> {
    return this.roster.isArchived(groupId);
  }

  isSuspended(accountId: string): Promise<boolean> {
    return this.roster.isSuspended(accountId);
  }
}
