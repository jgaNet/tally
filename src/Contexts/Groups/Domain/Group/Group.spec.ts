import { expect } from '@jest/globals';

import { Id } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';

import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  ArchiveWaitsForPayment,
  BalancesNotSettled,
  OnlyTheOwnerMayArchive,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';

const created = new Date('2026-11-18T10:00:00.000Z');
const archivedOn = new Date('2026-11-19T10:00:00.000Z');
const ann = new Id('ann');
const bob = new Id('bob');

/** A group Ann owns, with Bob in it. */
const aGroup = (): Group => {
  const group = Group.create({
    name: GroupName.create('Trip').data as GroupName,
    currency: Currency.create('EUR').data as Currency,
    ownerId: ann,
    now: created,
  });
  group.join({ accountId: bob, now: created });
  return group;
};

const archive = (group: Group, by: Id, balances: number[], paymentWaiting = false) =>
  group.archive({ accountId: by, balances, paymentWaiting, now: archivedOn });

describe('Group archived by its owner (request 27)', () => {
  it('is archived by its owner once every balance is 0 and no payment waits, and keeps the time', () => {
    const group = aGroup();

    expect(archive(group, ann, [0, 0]).isFailure()).toBe(false);

    expect(group.isArchived()).toBe(true);
    expect(group.archivedAt).toEqual(archivedOn);
    expect(group.toSnapshot().archivedAt).toBe(archivedOn.toISOString());
    expect(Group.fromSnapshot(group.toSnapshot()).archivedAt).toEqual(archivedOn);
  });

  it('is refused for a member who is not its owner, for a balance that is not 0, and while a payment waits', () => {
    const group = aGroup();

    const byMember = archive(group, bob, [0, 0]);
    expect(byMember.isFailure()).toBe(true);
    expect(byMember.error).toBeInstanceOf(OnlyTheOwnerMayArchive);

    const unsettled = archive(group, ann, [500, -500]);
    expect(unsettled.error).toBeInstanceOf(BalancesNotSettled);

    const waiting = archive(group, ann, [0, 0], true);
    expect(waiting.error).toBeInstanceOf(ArchiveWaitsForPayment);

    expect(group.isArchived()).toBe(false);
  });

  it('refuses every change once archived by the one name, and is not archived again', () => {
    const group = aGroup();
    archive(group, ann, [0, 0]);

    expect(archive(group, ann, [0, 0]).error).toBeInstanceOf(GroupArchived);
    expect(group.join({ accountId: new Id('carl'), now: archivedOn }).error).toBeInstanceOf(GroupArchived);
    expect(group.leave({ accountId: bob, balance: 0, paymentWaiting: false, now: archivedOn }).error).toBeInstanceOf(
      GroupArchived,
    );
    expect(group.members.map(member => member.accountId.value)).toEqual(['ann', 'bob']);
  });
});
