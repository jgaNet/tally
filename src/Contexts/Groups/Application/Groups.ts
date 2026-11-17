import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { decideCreateGroup, decideLeaveGroup } from '@Contexts/Groups/Domain/Group/Group.decision';

import { GroupView, IGroupQueries, MemberView } from '@Contexts/Groups/Domain/IGroupQueries';
import { IGroupRepository } from './IGroupRepository';
import { IMemberBalances } from './IMemberBalances';
import { IWaitingPayments } from './IWaitingPayments';

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

/**
 * A member leaves the group (request 20): the balance it has in the group, read from Ledger, passes to the owner in the same step, and
 * the member is taken out, `MemberLeft` and `BalancePassed` recorded and published after the save. The owner is refused, and so is a
 * member whose payment through the provider is waiting. The balance and the waiting payments are read, the decision made and the group
 * saved in one transaction on the groups' file, so an expense or a settlement recorded at the same moment is either before the leave, and
 * counted in what passes, or after it, and refused because its member is gone (ADR 16, ADR 17). Anyone who is not a member gets the answer
 * for a group that does not exist. The group is saved at the version it was read at, so a concurrent change is re-read and decided again
 * (CONC-OPTIMISTIC).
 */
export const leaveGroup = command(
  'LeaveGroup',
  (groups: IGroupRepository, balances: IMemberBalances, waiting: IWaitingPayments, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      return groups.inTransaction(async () => {
        const group = await groups.get(id);
        if (!group || !group.hasMember(by)) return Result.fail(new NotFoundException('Groups', 'No group is found'));

        const decision = decideLeaveGroup(
          {
            ownerId: group.ownerId,
            balance: await balances.balanceOf(id, by),
            waiting: await waiting.waitingOf(id, by),
          },
          { by },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const left = group.leave(by, clock(), decision.data.state.balancePassed);
        if (left.isFailure()) return left;
        await groups.save(group);
        await publishDomainEvents(group, context);
        return Result.ok(undefined);
      });
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

/** A member lists the members of the group, in the order they joined, the owner first; anyone else gets a `404`. */
export const getGroupMembers = query(
  'GetGroupMembers',
  (groups: IGroupQueries) =>
    async ({ id }: { id: string }, context) => {
      const members: MemberView[] | undefined = await groups.membersOf(id, callerOf(context));
      if (!members) return Result.fail(new NotFoundException('Groups', 'No group is found'));
      return Result.ok(members);
    },
);
