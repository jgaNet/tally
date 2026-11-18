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
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

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

describe('Group merged into another by the owner of both (request 31)', () => {
  const cara = new Id('cara');
  const dan = new Id('dan');
  const later = new Date('2026-11-20T10:00:00.000Z');

  const groupOf = (name: string, currency: string, owner: Id, others: Id[] = []): Group => {
    const group = Group.create({
      name: GroupName.create(name).data as GroupName,
      currency: Currency.create(currency).data as Currency,
      ownerId: owner,
      now: created,
    });
    for (const other of others) group.join({ accountId: other, now: created });
    return group;
  };

  it('joins the members of the group merged after its own, and keeps its former members and its passages', () => {
    const kept = groupOf('Flat', 'EUR', ann, [bob]);
    const merged = groupOf('Groceries', 'EUR', ann, [cara, bob]);
    merged.leave({ accountId: cara, balance: 300, paymentWaiting: false, now: later });

    const absorbed = kept.absorb({ accountId: ann, merged, paymentWaiting: false, now: later });

    expect(absorbed.isFailure()).toBe(false);
    expect(kept.members.map(member => member.accountId.value)).toEqual(['ann', 'bob']);
    expect(kept.departed.map(member => member.accountId.value)).toEqual(['cara']);
    expect(kept.passages).toEqual([{ from: cara, to: ann, amount: 300 }]);
  });

  it('adds the members of the group merged who were not in the group kept, joining at the merge, in their order there', () => {
    const kept = groupOf('Flat', 'EUR', ann, [bob]);
    const merged = groupOf('Trip', 'EUR', ann, [dan, cara]);

    kept.absorb({ accountId: ann, merged, paymentWaiting: false, now: later });

    expect(kept.members.map(member => member.accountId.value)).toEqual(['ann', 'bob', 'dan', 'cara']);
    expect(kept.members.slice(2).every(member => member.joinedAt.getTime() === later.getTime())).toBe(true);
  });

  it('is refused unless the caller owns both groups, they are in one currency, and they are not one group', () => {
    const kept = groupOf('Flat', 'EUR', ann, [bob]);
    const merged = groupOf('Trip', 'EUR', ann);
    const notOwnedByCaller = groupOf('Other', 'EUR', bob);
    const usd = groupOf('US', 'USD', ann);

    const refusedBy = (result: { isFailure(): boolean; error?: unknown }) =>
      result.isFailure() ? (result.error as { type: string }).type : null;

    expect(refusedBy(kept.absorb({ accountId: bob, merged, paymentWaiting: false, now: later }))).toBe(
      'OnlyTheOwnerMayMerge',
    );
    expect(
      refusedBy(kept.absorb({ accountId: ann, merged: notOwnedByCaller, paymentWaiting: false, now: later })),
    ).toBe('OnlyTheOwnerMayMerge');
    expect(refusedBy(kept.absorb({ accountId: ann, merged: usd, paymentWaiting: false, now: later }))).toBe(
      'CurrenciesDiffer',
    );
    expect(refusedBy(kept.absorb({ accountId: ann, merged: kept, paymentWaiting: false, now: later }))).toBe(
      'MergeIntoItself',
    );
    expect(kept.members.map(member => member.accountId.value)).toEqual(['ann', 'bob']);
  });

  it('is refused while a payment in the group merged waits, and when either group is archived', () => {
    const kept = groupOf('Flat', 'EUR', ann);
    const merged = groupOf('Trip', 'EUR', ann);

    expect(kept.absorb({ accountId: ann, merged, paymentWaiting: true, now: later }).isFailure()).toBe(true);

    merged.archive({ accountId: ann, balances: [0], paymentWaiting: false, now: later });
    expect(kept.absorb({ accountId: ann, merged, paymentWaiting: false, now: later }).isFailure()).toBe(true);
  });

  it('records GroupsMerged on the group kept', () => {
    const kept = groupOf('Flat', 'EUR', ann);
    const merged = groupOf('Trip', 'EUR', ann);

    kept.absorb({ accountId: ann, merged, paymentWaiting: false, now: later });

    expect(kept.toSnapshot().members.map(member => member.accountId)).toEqual(['ann']);
    expect(GroupsMergedEvent.set({ groupId: 'a', mergedGroupId: 'b' }).payload).toEqual({
      groupId: 'a',
      mergedGroupId: 'b',
    });
  });
});
