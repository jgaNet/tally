import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
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
