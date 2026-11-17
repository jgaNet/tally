import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { Group } from '@Contexts/Groups/Domain/Group/Group';

/** Creates a group: a signed-in person, who becomes its owner and first member. Its id is the answer. */
export const createGroup = command(
  'CreateGroup',
  (groups: IGroupRepository, clock: Clock) =>
    async ({ name, currency }: { name: string; currency: string }, context) => {
      const group = Group.register({ name, currency, ownerId: callerOf(context), at: clock() });
      if (group.isFailure()) return group;

      const saved = await groups.save(group.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(group.data, context);
      return Result.ok(group.data.id);
    },
);

/** Reads a group, for its members only: for anyone else it does not exist. */
export const getGroup = query('GetGroup', (groups: IGroupQueries) => async ({ id }: { id: string }, context) => {
  const group = await groups.findGroupOf(callerOf(context), id);
  if (!group) return Result.fail(new NotFoundException('Groups', 'There is no such group'));
  return Result.ok(group);
});

/** Lists the groups the caller is a member of, the most recently created first. */
export const getMyGroups = query(
  'GetMyGroups',
  (groups: IGroupQueries) => async (_input: void, context) => Result.ok(await groups.listGroupsOf(callerOf(context))),
);

/** Lists the members of a group, in the order they joined, for its members only: for anyone else it does not exist. */
export const getGroupMembers = query(
  'GetGroupMembers',
  (groups: IGroupQueries) =>
    async ({ id }: { id: string }, context) => {
      const members = await groups.listMembersOf(callerOf(context), id);
      if (!members) return Result.fail(new NotFoundException('Groups', 'There is no such group'));
      return Result.ok(members);
    },
);

/**
 * Takes the caller out of a group, once its balance in it is 0 (request 9, docs/adr/0009). Only a member may leave: for anyone
 * else the group does not exist. The owner never leaves. The balance is asked of Ledger when this decides, through
 * MemberBalances, and the departure is stored with its MemberLeft event.
 */
export const leaveGroup = command(
  'LeaveGroup',
  (groups: IGroupRepository, balances: IMemberBalances, clock: Clock) =>
    async ({ groupId }: { groupId: string }, context) => {
      const by = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.isMember(by)) return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      const balance = await balances.balanceOf(groupId, by);
      const left = group.leave({ accountId: by, balance, at: clock() });
      if (left.isFailure()) return left;

      const saved = await groups.save(group);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);
