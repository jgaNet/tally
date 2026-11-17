import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupNotFoundException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** One member of a group as a screen shows it: the account, its name, its role and when it joined (feature 3). */
export interface MemberView {
  readonly memberId: string;
  readonly name: string;
  readonly role: 'owner' | 'member';
  readonly joinedAt: string;
}

/** A group creation as the request carries it. The currency is one of the six the domain allows, checked there. */
export interface CreateGroupInput {
  readonly name: string;
  readonly currency: string;
}

/**
 * Creates a group for the signed-in person, who owns it and is its first member. The group is saved, and what it recorded
 * (GroupCreated, ADR 5) goes out with the commit, through the outbox: nothing subscribes to it yet. Answers the new id.
 */
export const createGroup = command(
  'CreateGroup',
  (groups: IGroupStore, clock: Clock) =>
    async (input: CreateGroupInput, context): Promise<IResult<string>> => {
      const created = Group.register({ ...input, ownerId: callerOf(context) }, clock());
      if (created.isFailure()) return created;

      await groups.add(created.data);
      await publishDomainEvents(created.data, context);
      return Result.ok(created.data.toSnapshot().id);
    },
);

/**
 * The group as the signed-in person sees it: only if they are one of its members. To anyone else it does not exist, so
 * the answer is the same `404` for a group that is not there and one that is someone else's.
 */
export const getGroup = query(
  'GetGroup',
  (groups: IGroupStore) =>
    async (groupId: string, context): Promise<IResult<GroupView>> => {
      const view = await groups.viewFor(groupId, callerOf(context));
      return view ? Result.ok(view) : Result.fail(new GroupNotFoundException());
    },
);

/**
 * The members of a group, in the order they joined, the earliest first (the owner, who created it, is first). Only a
 * member sees them: to anyone else the group does not exist, the same `404` as in GetGroup. Each member's name is read
 * from its account.
 */
export const getGroupMembers = query(
  'GetGroupMembers',
  (groups: IGroupStore, accounts: IAccountStore) =>
    async (groupId: string, context): Promise<IResult<MemberView[]>> => {
      const caller = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.hasMember(caller)) return Result.fail(new GroupNotFoundException());

      const members: MemberView[] = [];
      for (const member of group.members()) {
        const account = await accounts.view(member.accountId);
        if (!account) throw new Error(`The member ${member.accountId} of the group ${groupId} has no account`);
        members.push({
          memberId: member.accountId,
          name: account.name,
          role: member.accountId === group.ownerId ? 'owner' : 'member',
          joinedAt: member.joinedAt,
        });
      }
      return Result.ok(members);
    },
);

/** The groups the signed-in person is a member of, the most recently created first (the store's order, ADR 5). */
export const getMyGroups = query(
  'GetMyGroups',
  (groups: IGroupStore) =>
    async (_input: undefined, context): Promise<IResult<GroupView[]>> =>
      Result.ok(await groups.listFor(callerOf(context))),
);
