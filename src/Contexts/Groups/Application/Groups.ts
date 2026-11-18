import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { IGroupAuditLog } from '@Contexts/Groups/Application/IGroupAuditLog';
import { IMemberBalances, IWaitingPayments } from '@Contexts/Groups/Application/IMemberBalances';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { balancePassedAuditId } from '@Contexts/Groups/Domain/Group/GroupAudit';
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
        // A deleted member is still a member, at their place, and is named `Deleted account` (feature 35, request 35).
        const name = await accounts.memberName(member.accountId);
        if (name === undefined)
          throw new Error(`The member ${member.accountId} of the group ${groupId} has no account`);
        members.push({
          memberId: member.accountId,
          name,
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

/**
 * The signed-in person leaves a group they are a member of (feature 9, request 20). Whatever their balance in it: it passes to
 * the owner in the same step, and is read through the owned port MemberBalances in the leave's own transaction, so an expense or
 * a settlement recorded at the same moment is either counted in it or refused. Refused with `422` while a payment of theirs waits
 * at the provider (the owned port WaitingPayments), with `403` for the owner, who stays. To anyone who is not a member the group
 * does not exist: the same `404`. Once they have left, the group is not among their groups and its members do not include them;
 * what concerns them is kept as it was. What it recorded (BalancePassed, MemberLeft) goes out with the commit, through the outbox.
 */
export const leaveGroup = command(
  'LeaveGroup',
  (groups: IGroupStore, balances: IMemberBalances, waiting: IWaitingPayments, audit: IGroupAuditLog, clock: Clock) =>
    async (groupId: string, context): Promise<IResult<void>> => {
      const caller = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.hasMember(caller)) return Result.fail(new GroupNotFoundException());

      const reading = {
        balance: await balances.balanceOf(groupId, caller),
        paymentWaiting: await waiting.hasWaitingPayment(groupId, caller),
      };
      const now = clock();
      const left = group.leave(caller, reading, now);
      if (left.isFailure()) return left;

      await groups.save(group);
      // The balance the member passed is their change, in the leave's transaction; a balance of 0 passes nothing (request 28).
      if (reading.balance !== 0) {
        await audit.record({
          id: balancePassedAuditId(groupId, group.passes().length - 1),
          groupId,
          at: now.toISOString(),
          by: caller,
          action: 'balance-passed',
          subjectId: caller,
          amount: reading.balance,
        });
      }
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);

/**
 * The owner archives a group (feature 27, request 27): once every member's balance is 0 (MemberBalances, read for each member in the
 * archive's own transaction) and no payment through the provider waits (WaitingPayments, read for each member: a pending or refunding
 * payment always involves a member who has not left). Refused, and nothing changes: with GroupArchived to a group already archived,
 * `403` to a member who is not its owner, `422` GroupNotSettled while a balance is not 0 or a payment waits, and `404` to anyone who
 * is not a member. What it recorded (GroupArchived) goes out with the commit, through the outbox. Answers nothing.
 */
export const archiveGroup = command(
  'ArchiveGroup',
  (groups: IGroupStore, balances: IMemberBalances, waiting: IWaitingPayments, clock: Clock) =>
    async (groupId: string, context): Promise<IResult<void>> => {
      const caller = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.hasMember(caller)) return Result.fail(new GroupNotFoundException());

      let balancesCleared = true;
      let paymentWaiting = false;
      for (const member of group.members()) {
        if ((await balances.balanceOf(groupId, member.accountId)) !== 0) balancesCleared = false;
        if (await waiting.hasWaitingPayment(groupId, member.accountId)) paymentWaiting = true;
      }
      const archived = group.archive(caller, { balancesCleared, paymentWaiting }, clock());
      if (archived.isFailure()) return archived;

      await groups.save(group);
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);

/** The two groups a merge names: the group kept (the one merged into, by its id in the path) and the group merged (`from`). */
export interface MergeGroupsInput {
  readonly groupId: string;
  readonly from: string;
}

/**
 * The owner of two groups merges the group `from` into the group `groupId`, which is kept (feature 31, request 31). Both must be groups the
 * signed-in person is a member of, so to anyone else either is not there (`404`); the decision is the group kept's (Group.merge): the same
 * owner for both (`403`), not one group, one currency, neither archived (GroupArchived), and no payment through the provider waiting in the
 * group merged (WaitingPayments, asked of each member of it, read in the merge's own transaction). The group merged is closed in the same
 * write (IGroupStore.merge), and what it recorded (GroupsMerged) goes out with the commit, through the outbox. Answers nothing.
 */
export const mergeGroups = command(
  'MergeGroups',
  (groups: IGroupStore, waiting: IWaitingPayments, clock: Clock) =>
    async (input: MergeGroupsInput, context): Promise<IResult<void>> => {
      const caller = callerOf(context);
      const kept = await groups.findById(input.groupId);
      if (!kept || !kept.hasMember(caller)) return Result.fail(new GroupNotFoundException());
      const merged = await groups.findById(input.from);
      if (!merged || !merged.hasMember(caller)) return Result.fail(new GroupNotFoundException());

      let paymentWaiting = false;
      for (const member of merged.members()) {
        if (await waiting.hasWaitingPayment(input.from, member.accountId)) paymentWaiting = true;
      }
      const now = clock();
      const merging = kept.merge(merged, caller, { paymentWaiting }, now);
      if (merging.isFailure()) return merging;

      await groups.merge(kept, merged, now.toISOString());
      await publishDomainEvents(kept, context);
      return Result.ok(undefined);
    },
);
