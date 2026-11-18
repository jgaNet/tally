import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';

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
 * Merges the group `from` into the group `groupId`, which is kept, for the owner of both (request 31, docs/adr/0031): the caller must be a
 * member of both, or they do not exist for it. The kept group takes the members of the group merged and their balances, the group merged
 * is removed with its memberships and its invitations, and its passed balances are the kept group's, in this transaction. A payment in the
 * group merged that waits at the provider, read through Settlements' port in the same transaction, refuses the merge. Ledger and Settlements
 * move what they hold of the group merged in reactions to the GroupsMerged event, which GroupsMergedHandler publishes after the commit.
 */
export const mergeGroups = command(
  'MergeGroups',
  (groups: IGroupRepository, invitations: IInvitationRepository, payments: IWaitingPayments, clock: Clock) =>
    async ({ groupId, from }: { groupId: string; from: string }, context) => {
      const by = callerOf(context);
      const kept = await groups.findById(groupId);
      if (!kept || !kept.isMember(by)) return Result.fail(new NotFoundException('Groups', 'There is no such group'));
      const merged = await groups.findById(from);
      if (!merged || !merged.isMember(by))
        return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      let paymentWaiting = false;
      for (const member of merged.members) {
        if (await payments.paymentWaitingOf(from, member.accountId)) paymentWaiting = true;
      }
      const absorbed = kept.absorb({ merged, by, paymentWaiting, at: clock() });
      if (absorbed.isFailure()) return absorbed;

      const saved = await groups.save(kept);
      if (saved.isFailure()) return saved;
      const removed = await groups.remove(merged);
      if (removed.isFailure()) return removed;
      await groups.movePassedBalances(from, groupId);
      await invitations.removeOfGroup(from);
      await publishDomainEvents(kept, context);
      return Result.ok(undefined);
    },
);

/**
 * Archives a group, for its owner (request 27, docs/adr/0026): once every current member's balance is 0 and no payment in it waits at
 * the provider. The balances are asked of Ledger, and the payments of Settlements, through the ports Groups owns, when this decides, in
 * this transaction. For anyone outside the group it does not exist; any other member is refused, and an archived group stays archived.
 */
export const archiveGroup = command(
  'ArchiveGroup',
  (groups: IGroupRepository, balances: IMemberBalances, payments: IWaitingPayments, clock: Clock) =>
    async ({ groupId }: { groupId: string }, context) => {
      const by = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.isMember(by)) return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      const current = group.members.map(member => member.accountId);
      const owed: number[] = [];
      const waiting: boolean[] = [];
      for (const accountId of current) {
        owed.push(await balances.balanceOf(groupId, accountId));
        waiting.push(await payments.paymentWaitingOf(groupId, accountId));
      }
      const archived = group.archive({ by, balances: owed, paymentWaiting: waiting.some(Boolean), at: clock() });
      if (archived.isFailure()) return archived;

      const saved = await groups.save(group);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);

/**
 * Takes the caller out of a group, at whatever its balance (request 20, docs/adr/0019; request 9, docs/adr/0009). Only a member may
 * leave: for anyone else the group does not exist. The owner never leaves, and not while a payment of the caller waits at the
 * provider. The balance is asked of Ledger when this decides, through MemberBalances, and what passes to the owner is stored with
 * the departure, its BalancePassed and MemberLeft events, in this transaction.
 */
export const leaveGroup = command(
  'LeaveGroup',
  (groups: IGroupRepository, balances: IMemberBalances, payments: IWaitingPayments, clock: Clock) =>
    async ({ groupId }: { groupId: string }, context) => {
      const by = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.isMember(by)) return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      const balance = await balances.balanceOf(groupId, by);
      const waitingPayment = await payments.paymentWaitingOf(groupId, by);
      const left = group.leave({ accountId: by, balance, waitingPayment, at: clock() });
      if (left.isFailure()) return left;

      const saved = await groups.save(group);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);
