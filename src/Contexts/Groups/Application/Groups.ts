import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { decideCreateGroup } from '@Contexts/Groups/Domain/Group/Group.decision';

import { GroupView, IGroupQueries } from './IGroupQueries';
import { IGroupRepository } from './IGroupRepository';

/**
 * A signed-in person creates a group in one of the six currencies, fixed for good, and owns it: its owner is its first
 * member. Answers the new group's id.
 */
export const createGroup = command(
  'CreateGroup',
  (groups: IGroupRepository, clock: Clock) =>
    async ({ name, currency }: { name: string; currency: string }, context) => {
      const decision = decideCreateGroup(undefined, { name, currency }, clock());
      if (decision.isFailure()) return decision;

      const group = Group.register({ ...decision.data.state, ownerId: callerOf(context), at: clock() });
      await groups.insert(group);
      await publishDomainEvents(group, context);
      return Result.ok(group._id.value);
    },
);

/** A member reads the group; anyone else, or nobody, gets the same answer as for a group that does not exist. */
export const getGroup = query('GetGroup', (groups: IGroupQueries) => async ({ id }: { id: string }, context) => {
  const group: GroupView | undefined = await groups.groupOf(id, callerOf(context));
  if (!group) return Result.fail(new NotFoundException('Groups', 'No group is found'));
  return Result.ok(group);
});

/** The groups the caller is a member of, the most recently created first. */
export const getMyGroups = query(
  'GetMyGroups',
  (groups: IGroupQueries) => async (_input: void, context) => Result.ok(await groups.groupsOf(callerOf(context))),
);
