import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import {
  decideArchiveGroup,
  decideCreateGroup,
  decideLeaveGroup,
  decideMergeGroups,
} from '@Contexts/Groups/Domain/Group/Group.decision';

import { GroupView, IGroupQueries, MemberView } from '@Contexts/Groups/Domain/IGroupQueries';
import { IGroupRepository } from './IGroupRepository';
import { IMemberBalances } from './IMemberBalances';
import { IWaitingPayments } from './IWaitingPayments';

/**
 * The owner archives the group (request 27), once every member's balance (read from Ledger) is 0 and no payment of theirs through the provider
 * is pending or being refunded (read from Settlements): nothing in it changes after. Refused for anyone but its owner, and for a group already
 * archived. Anyone who is not a member gets the answer for a group that does not exist. The balances and the waiting payments are read, the
 * decision made and the group saved in one transaction on the groups' file, as a leaving is (ADR 16, ADR 17); the group is saved at the version it
 * was read at (CONC-OPTIMISTIC).
 */
export const archiveGroup = command(
  'ArchiveGroup',
  (groups: IGroupRepository, balances: IMemberBalances, waiting: IWaitingPayments, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      return groups.inTransaction(async () => {
        const group = await groups.get(id);
        if (!group || !group.hasMember(by)) return Result.fail(new NotFoundException('Groups', 'No group is found'));

        const memberIds = group.members.map(member => member.accountId);
        const balanceOfEach: number[] = [];
        let anyWaiting = false;
        for (const memberId of memberIds) {
          balanceOfEach.push(await balances.balanceOf(id, memberId));
          anyWaiting = anyWaiting || (await waiting.waitingOf(id, memberId));
        }
        const at = clock();
        const decision = decideArchiveGroup(
          {
            archived: group.archivedAt !== undefined,
            ownerId: group.ownerId,
            balances: balanceOfEach,
            waiting: anyWaiting,
          },
          { by },
          at,
        );
        if (decision.isFailure()) return decision;

        const archived = group.archive(at);
        if (archived.isFailure()) return archived;
        await groups.save(group);
        await publishDomainEvents(group, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * The owner of two groups of one currency merges the group `from` into the group `id`, which is kept (request 31): the members of the group
 * merged join the group kept, after its members, in the order they joined the group merged; the group merged is closed, so it is no group for
 * anyone at once, and the balances that passed to its owner are the group kept's. Its expenses, settlements, recurring expenses and audit move
 * in the reactions to the published `GroupsMerged`, and its budgets, templates and invitations are not moved (ADR 28). Refused for anyone but the
 * owner of both, for the same group twice, two currencies, an archived group (request 27), and while a payment through the provider waits in
 * the group merged. Anyone who is not a member of a group gets the answer for a group that does not exist. Both groups are read, the decision
 * made and both saved in one transaction on the groups' file, so an expense or a settlement recorded at the same moment is either before the
 * merge, and moves with it, or after it, and refused because the group merged is gone (ADR 17). Each group is saved at the version it was read
 * at (CONC-OPTIMISTIC).
 */
export const mergeGroups = command(
  'MergeGroups',
  (groups: IGroupRepository, waiting: IWaitingPayments, clock: Clock) =>
    async ({ id, from }: { id: string; from: string }, context) => {
      const by = callerOf(context);
      return groups.inTransaction(async () => {
        const kept = await groups.get(id);
        if (!kept || !kept.hasMember(by)) return Result.fail(new NotFoundException('Groups', 'No group is found'));
        const merged = await groups.get(from);
        if (!merged || !merged.hasMember(by)) return Result.fail(new NotFoundException('Groups', 'No group is found'));

        let anyWaiting = false;
        for (const member of merged.members) {
          anyWaiting = anyWaiting || (await waiting.waitingOf(from, member.accountId));
        }
        const at = clock();
        const decision = decideMergeGroups(
          {
            kept: { ownerId: kept.ownerId, currency: kept.currency.value, archived: kept.archivedAt !== undefined },
            merged: {
              ownerId: merged.ownerId,
              currency: merged.currency.value,
              archived: merged.archivedAt !== undefined,
            },
            waiting: anyWaiting,
          },
          { by, sameGroup: id === from },
          at,
        );
        if (decision.isFailure()) return decision;

        const absorbed = kept.absorb(merged, at);
        if (absorbed.isFailure()) return absorbed;
        const closed = merged.closeInto(id);
        if (closed.isFailure()) return closed;
        await groups.save(kept);
        await groups.save(merged);
        await groups.movePasses(from, id);
        await publishDomainEvents(kept, context);
        return Result.ok(undefined);
      });
    },
);

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
            archived: group.archivedAt !== undefined,
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
