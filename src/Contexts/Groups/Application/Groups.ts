import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupNotFoundException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

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

/** The groups the signed-in person is a member of, the most recently created first (the store's order, ADR 5). */
export const getMyGroups = query(
  'GetMyGroups',
  (groups: IGroupStore) =>
    async (_input: undefined, context): Promise<IResult<GroupView[]>> =>
      Result.ok(await groups.listFor(callerOf(context))),
);
