import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  BalancePassedEvent,
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

const valueOf = <T>(result: IResult<T>): T => {
  if (result.isFailure()) throw result.error;
  return result.data as T;
};

const AT = new Date('2026-11-01T10:00:00.000Z');

const created = () => valueOf(Group.found({ name: 'The flat', currency: 'EUR', ownerId: 'ana', createdAt: AT }));

describe('Currency', () => {
  it('accepts the six currencies and refuses any other', () => {
    for (const code of ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD']) {
      expect(Currency.create(code).isSuccess()).toBe(true);
    }
    expect(Currency.create('JPY').isFailure()).toBe(true);
    expect(Currency.create('eur').isFailure()).toBe(true);
  });
});

describe('GroupName', () => {
  it('keeps a name of 1 to 60 characters, trimmed, and refuses the rest', () => {
    expect(valueOf(GroupName.create('  Trip  ')).value).toBe('Trip');
    expect(GroupName.create('   ').isFailure()).toBe(true);
    expect(GroupName.create('').isFailure()).toBe(true);
    expect(GroupName.create('x'.repeat(60)).isSuccess()).toBe(true);
    expect(GroupName.create('x'.repeat(61)).isFailure()).toBe(true);
  });
});

describe('Group', () => {
  it('refuses a name or a currency that is not allowed', () => {
    const at = { ownerId: 'ana', createdAt: AT };

    expect(Group.found({ name: '   ', currency: 'EUR', ...at }).isFailure()).toBe(true);
    expect(Group.found({ name: 'Trip', currency: 'JPY', ...at }).isFailure()).toBe(true);
  });

  it('founds a group whose owner is its first member, and records its creation', () => {
    const group = created();

    expect(group.ownerId).toBe('ana');
    expect(group.members.map(member => member.accountId)).toEqual(['ana']);
    expect(group.isMember('ana')).toBe(true);
    expect(group.currency.value).toBe('EUR');

    const events = group.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(GroupCreatedEvent);
    expect(events[0].payload).toEqual({ groupId: group._id.value, ownerId: 'ana' });
  });

  it('rebuilds from a snapshot without recording anything, and keeps its members and creation time', () => {
    const snapshot = created().toSnapshot();
    const rebuilt = Group.fromSnapshot(snapshot);

    expect(rebuilt.pullDomainEvents()).toEqual([]);
    expect(rebuilt.toSnapshot()).toEqual(snapshot);
    expect(rebuilt.createdAt).toEqual(AT);
  });

  it('refuses to rebuild a corrupted snapshot', () => {
    const snapshot = created().toSnapshot();

    expect(() => Group.fromSnapshot({ ...snapshot, currency: 'JPY' })).toThrow();
    expect(() => Group.fromSnapshot({ ...snapshot, members: [] })).toThrow();
  });

  it('adds a member who joins at the time given, last, and records MemberJoined', () => {
    const group = created();
    group.pullDomainEvents();
    const JOINED = new Date('2026-11-02T09:00:00.000Z');

    expect(valueOf(group.join({ accountId: 'ben', joinedAt: JOINED }))).toBeUndefined();

    expect(group.members.map(member => member.accountId)).toEqual(['ana', 'ben']);
    expect(group.members[1].joinedAt).toEqual(JOINED);
    expect(group.isMember('ben')).toBe(true);
    const events = group.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(MemberJoinedEvent);
    expect(events[0].payload).toEqual({ groupId: group._id.value, accountId: 'ben' });
  });

  it('refuses a member who is already in the group, and keeps the group as it was', () => {
    const group = created();
    group.pullDomainEvents();

    const again = group.join({ accountId: 'ana', joinedAt: AT });

    expect(again.isFailure()).toBe(true);
    expect(again.error).toMatchObject({ type: 'AlreadyMember' });
    expect(group.members).toHaveLength(1);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('keeps the members with when each joined through a snapshot', () => {
    const group = created();
    valueOf(group.join({ accountId: 'ben', joinedAt: new Date('2026-11-02T09:00:00.000Z') }));
    const rebuilt = Group.fromSnapshot(group.toSnapshot());

    expect(rebuilt.toSnapshot().members).toEqual([
      { accountId: 'ana', joinedAt: AT.toISOString() },
      { accountId: 'ben', joinedAt: '2026-11-02T09:00:00.000Z' },
    ]);
  });
});

describe('Group.leave', () => {
  const JOINED = new Date('2026-11-02T09:00:00.000Z');
  const withBen = () => {
    const group = created();
    valueOf(group.join({ accountId: 'ben', joinedAt: JOINED }));
    group.pullDomainEvents();
    return group;
  };

  it('lets a member with a balance of 0 leave, and records BalancePassed of 0 then MemberLeft', () => {
    const group = withBen();

    expect(group.leave({ accountId: 'ben', balance: 0, paymentWaiting: false }).isSuccess()).toBe(true);

    expect(group.members.map(member => member.accountId)).toEqual(['ana']);
    expect(group.isMember('ben')).toBe(false);
    const events = group.pullDomainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(BalancePassedEvent);
    expect(events[0].payload).toEqual({ groupId: group._id.value, from: 'ben', to: 'ana', amount: 0 });
    expect(events[1]).toBeInstanceOf(MemberLeftEvent);
    expect(events[1].payload).toEqual({ groupId: group._id.value, accountId: 'ben' });
  });

  it('lets a member leave whatever their balance, and passes it to the owner in the same step', () => {
    const group = withBen();

    expect(group.leave({ accountId: 'ben', balance: -300, paymentWaiting: false }).isSuccess()).toBe(true);

    expect(group.isMember('ben')).toBe(false);
    expect(group.passings).toEqual([{ from: 'ben', to: 'ana', amount: -300 }]);
    const events = group.pullDomainEvents();
    expect(events[0]).toBeInstanceOf(BalancePassedEvent);
    expect(events[0].payload).toEqual({ groupId: group._id.value, from: 'ben', to: 'ana', amount: -300 });
  });

  it('keeps the passings through a snapshot, in the order they were passed', () => {
    const group = withBen();
    group.leave({ accountId: 'ben', balance: 300, paymentWaiting: false });

    expect(Group.fromSnapshot(group.toSnapshot()).passings).toEqual([{ from: 'ben', to: 'ana', amount: 300 }]);
  });

  it('refuses the owner, always, and keeps the group as it was', () => {
    const group = withBen();

    const refused = group.leave({ accountId: 'ana', balance: 0, paymentWaiting: false });

    expect(refused.isFailure() && refused.error.type).toBe('OwnerCannotLeave');
    expect(group.isMember('ana')).toBe(true);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('refuses a member with a payment waiting at the provider, as PaymentWaiting, and keeps them in the group', () => {
    const group = withBen();

    const refused = group.leave({ accountId: 'ben', balance: 0, paymentWaiting: true });

    expect(refused.isFailure() && refused.error.type).toBe('PaymentWaiting');
    expect(group.isMember('ben')).toBe(true);
    expect(group.passings).toEqual([]);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('refuses an account that is not a member as a group that does not exist', () => {
    const refused = withBen().leave({ accountId: 'zoe', balance: 0, paymentWaiting: false });

    expect(refused.isFailure() && refused.error.type).toBe('NotFound');
  });

  it('keeps the former member in the snapshot, and a member who joins again is last, from that moment', () => {
    const group = withBen();
    group.leave({ accountId: 'ben', balance: 0, paymentWaiting: false });
    const rebuilt = Group.fromSnapshot(group.toSnapshot());

    expect(rebuilt.toSnapshot().formerMembers).toEqual([{ accountId: 'ben', joinedAt: JOINED.toISOString() }]);
    const REJOINED = new Date('2026-11-20T08:00:00.000Z');
    valueOf(rebuilt.join({ accountId: 'cara', joinedAt: REJOINED }));
    valueOf(rebuilt.join({ accountId: 'ben', joinedAt: REJOINED }));

    expect(rebuilt.members.map(member => member.accountId)).toEqual(['ana', 'cara', 'ben']);
    expect(rebuilt.members[2].joinedAt).toEqual(REJOINED);
    expect(rebuilt.formerMembers).toEqual([]);
  });
});

describe('archiving a group (request 27)', () => {
  const LATER = new Date('2026-11-18T09:00:00.000Z');
  const archiveBy = (group: Group, askedBy: string, balances: number[], paymentsWaiting = false) =>
    group.archive({ askedBy, balances, paymentsWaiting, archivedAt: LATER });

  it('is archived by its owner once every balance is 0 and no payment waits, at the time given', () => {
    const group = created();
    expect(archiveBy(group, 'ana', [0, 0]).isSuccess()).toBe(true);
    expect(group.isArchived()).toBe(true);
    expect(group.archivedAt).toEqual(LATER);
  });

  it('refuses a member who is not the owner, a balance that is not 0, and a payment that waits', () => {
    const group = created();
    valueOf(group.join({ accountId: 'ben', joinedAt: AT }));
    expect(archiveBy(group, 'ben', [0, 0]).isFailure()).toBe(true);
    expect(archiveBy(group, 'ana', [0, 50]).isFailure()).toBe(true);
    expect(archiveBy(group, 'ana', [0, 0], true).isFailure()).toBe(true);
    expect(group.isArchived()).toBe(false);
  });

  it('refuses the archive again, a join and a leave once archived, by GroupArchived', () => {
    const group = created();
    valueOf(group.join({ accountId: 'ben', joinedAt: AT }));
    valueOf(archiveBy(group, 'ana', [0, 0]));
    const again = archiveBy(group, 'ana', [0, 0]);
    expect(again.isFailure() && again.error.type).toBe('GroupArchived');
    const joined = group.join({ accountId: 'cleo', joinedAt: AT });
    expect(joined.isFailure() && joined.error.type).toBe('GroupArchived');
    const left = group.leave({ accountId: 'ben', balance: 0, paymentWaiting: false });
    expect(left.isFailure() && left.error.type).toBe('GroupArchived');
    expect(group.members.map(member => member.accountId)).toEqual(['ana', 'ben']);
  });

  it('reads back its archive time from a snapshot, and an open group has none', () => {
    const group = created();
    expect(group.toSnapshot().archivedAt).toBeNull();
    valueOf(archiveBy(group, 'ana', [0]));
    const restored = Group.fromSnapshot(group.toSnapshot());
    expect(restored.isArchived()).toBe(true);
    expect(restored.archivedAt).toEqual(LATER);
  });
});
