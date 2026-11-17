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
    expect(group.memberIds.map(member => member.value)).toEqual(['owner-1']);
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
    expect(() => Group.fromSnapshot({ ...snapshot, memberIds: [] })).toThrow('Corrupted group');
  });
});
