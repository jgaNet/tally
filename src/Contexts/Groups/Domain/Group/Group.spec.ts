import { Id } from '@Architecture/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';

const at = new Date('2026-01-02T03:04:05.000Z');
const name = (value: string) => GroupName.create(value);
const currency = (value: string) => Currency.create(value);

describe('GroupName', () => {
  it.each(['a', 'Lisbon trip', 'a'.repeat(60)])('accepts %j', value => {
    expect(name(value).isFailure()).toBe(false);
  });

  it.each(['', '   ', 'a'.repeat(61)])('refuses %j with InvalidGroupName', value => {
    const result = name(value);
    expect(result.isFailure()).toBe(true);
    expect(result.isFailure() && result.error.type).toBe('InvalidGroupName');
  });
});

describe('Currency', () => {
  it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts %s', value => {
    expect(currency(value).isFailure()).toBe(false);
  });

  it.each(['JPY', 'eur', ''])('refuses %j with InvalidCurrency', value => {
    const result = currency(value);
    expect(result.isFailure() && result.error.type).toBe('InvalidCurrency');
  });
});

describe('Group', () => {
  const create = () =>
    Group.create({
      name: name('Flat').data as GroupName,
      currency: currency('EUR').data as Currency,
      ownerId: new Id('owner-1'),
      at,
    });

  it('is made with its owner as its first member, and records GroupCreated', () => {
    const group = create();
    expect(group.ownerId.value).toBe('owner-1');
    expect(group.members.map(member => member.accountId.value)).toEqual(['owner-1']);
    expect(group.hasMember(new Id('owner-1'))).toBe(true);
    expect(group.hasMember(new Id('someone-else'))).toBe(false);
    const events = group.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['GroupCreatedEvent']);
    expect(events[0].payload).toEqual({
      groupId: group._id.value,
      name: 'Flat',
      currency: 'EUR',
      ownerId: 'owner-1',
      createdAt: at.toISOString(),
    });
  });

  it('is reconstituted from its snapshot without recording anything', () => {
    const snapshot = create().toSnapshot();
    const again = Group.fromSnapshot({ ...snapshot, version: 1 });
    expect(again.toSnapshot()).toEqual({ ...snapshot, version: 1 });
    expect(again.pullDomainEvents()).toEqual([]);
  });

  it('refuses corrupted data by throwing', () => {
    const snapshot = create().toSnapshot();
    expect(() => Group.fromSnapshot({ ...snapshot, currency: 'JPY' })).toThrow('Corrupted group');
    expect(() => Group.fromSnapshot({ ...snapshot, members: [] })).toThrow('Corrupted group');
  });

  it('adds an account as a member from now on, and records MemberJoined', () => {
    const group = create();
    group.pullDomainEvents();
    const later = new Date('2026-02-03T04:05:06.000Z');
    expect(group.join(new Id('bob'), later).isFailure()).toBe(false);
    expect(group.hasMember(new Id('bob'))).toBe(true);
    expect(group.members.map(member => member.accountId.value)).toEqual(['owner-1', 'bob']);
    const events = group.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['MemberJoinedEvent']);
    expect(events[0].payload).toEqual({ groupId: group._id.value, accountId: 'bob', joinedAt: later.toISOString() });
  });

  it('refuses an account already a member, with AlreadyMember, and records nothing', () => {
    const group = create();
    group.pullDomainEvents();
    const result = group.join(new Id('owner-1'), at);
    expect(result.isFailure() && result.error.type).toBe('AlreadyMember');
    expect(group.members).toHaveLength(1);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('keeps when each member joined through its snapshot', () => {
    const group = create();
    group.join(new Id('bob'), new Date('2026-02-03T04:05:06.000Z'));
    const snapshot = group.toSnapshot();
    expect(snapshot.members).toEqual([
      { accountId: 'owner-1', joinedAt: at.toISOString(), leftAt: null },
      { accountId: 'bob', joinedAt: '2026-02-03T04:05:06.000Z', leftAt: null },
    ]);
    expect(Group.fromSnapshot({ ...snapshot, version: 1 }).toSnapshot()).toEqual({ ...snapshot, version: 1 });
  });
});
