import { Currency } from './Currency';
import { Group, GroupSnapshot } from './Group';
import { GroupCreatedEvent, MemberJoinedEvent } from './GroupEvents';
import { GroupName } from './GroupName';

const at = new Date('2026-04-01T09:00:00.000Z');
const later = new Date('2026-04-02T09:00:00.000Z');
const ownerId = '3c9d2f1e-0000-4000-8000-000000000001';
const otherId = '3c9d2f1e-0000-4000-8000-000000000002';

const registered = () =>
  Group.register({
    name: GroupName.create('Lisbon trip').data!,
    currency: Currency.create('EUR').data!,
    ownerId,
    at,
  });

describe('Group.register', () => {
  it('makes the group, owned by its creator, and records its creation', () => {
    const group = registered();

    expect(group._id.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(group.ownerId).toBe(ownerId);
    expect(group.pullDomainEvents()).toEqual([
      GroupCreatedEvent.set({ groupId: group._id.value, ownerId, createdAt: at }),
    ]);
  });

  it('starts with its owner as its first member, and at version 0 (not yet stored)', () => {
    const group = registered();
    expect(group.members).toEqual([{ accountId: ownerId, joinedAt: at }]);
    expect(group.version).toBe(0);
  });
});

describe('Group.join', () => {
  it('adds the account as the last member, and records the join', () => {
    const group = registered();
    group.pullDomainEvents();

    expect(group.join(otherId, later).isSuccess()).toBe(true);

    expect(group.members.map(member => member.accountId)).toEqual([ownerId, otherId]);
    expect(group.hasMember(otherId)).toBe(true);
    expect(group.pullDomainEvents()).toEqual([
      MemberJoinedEvent.set({ groupId: group._id.value, accountId: otherId, joinedAt: later }),
    ]);
  });

  it('refuses an account that is a member already, and records nothing', () => {
    const group = registered();
    group.pullDomainEvents();

    const again = group.join(ownerId, later);

    expect(again.isFailure()).toBe(true);
    expect(again.error?.type).toBe('AlreadyMember');
    expect(group.members).toHaveLength(1);
    expect(group.pullDomainEvents()).toEqual([]);
  });
});

describe('Group.fromSnapshot', () => {
  const stored: GroupSnapshot = {
    id: '6f1d2c3b-0000-4000-8000-0000000000aa',
    name: 'Lisbon trip',
    currency: 'EUR',
    ownerId,
    createdAt: at.toISOString(),
    members: [
      { accountId: ownerId, joinedAt: at.toISOString() },
      { accountId: otherId, joinedAt: later.toISOString() },
    ],
    version: 3,
  };

  it('rebuilds the group with its id, its members and the version it was stored at, recording nothing', () => {
    const group = Group.fromSnapshot(stored);

    expect(group._id.value).toBe(stored.id);
    expect(group.version).toBe(3);
    expect(group.members.map(member => member.accountId)).toEqual([ownerId, otherId]);
    expect(group.toSnapshot()).toEqual(stored);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('throws on data no registration or join could have made', () => {
    expect(() =>
      Group.fromSnapshot({ ...stored, members: [{ accountId: otherId, joinedAt: at.toISOString() }] }),
    ).toThrow(/corrupted/);
    expect(() =>
      Group.fromSnapshot({
        ...stored,
        members: [stored.members[0], stored.members[0]],
      }),
    ).toThrow(/corrupted/);
    expect(() => Group.fromSnapshot({ ...stored, currency: 'JPY' as GroupSnapshot['currency'] })).toThrow(/corrupted/);
  });
});
