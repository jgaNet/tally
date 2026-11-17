import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

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
    expect(group.members).toEqual(['ana']);
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
});
