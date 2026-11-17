import { Currency, CURRENCIES } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { InvalidCurrencyException, InvalidGroupNameException } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

const AT = new Date('2026-05-01T10:00:00.000Z');

describe('GroupName', () => {
  it('is 1 to 60 characters once trimmed, and not only spaces', () => {
    expect(GroupName.create('  Flat  ').data?.value).toBe('Flat');
    expect(GroupName.create('x'.repeat(60)).isSuccess()).toBe(true);
    expect(GroupName.create('').error).toBeInstanceOf(InvalidGroupNameException);
    expect(GroupName.create('   ').error).toBeInstanceOf(InvalidGroupNameException);
    expect(GroupName.create('x'.repeat(61)).error).toBeInstanceOf(InvalidGroupNameException);
  });
});

describe('Currency', () => {
  it('is one of the six currencies, and nothing else', () => {
    for (const code of CURRENCIES) expect(Currency.create(code).data?.value).toBe(code);
    expect(CURRENCIES).toEqual(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD']);
    expect(Currency.create('JPY').error).toBeInstanceOf(InvalidCurrencyException);
    expect(Currency.create('eur').error).toBeInstanceOf(InvalidCurrencyException);
  });
});

describe('Group', () => {
  const create = () => Group.register({ name: 'Lisbon', currency: 'EUR', ownerId: 'ada', at: AT }).data!;

  it('starts with its owner as its first member, and records GroupCreated once', () => {
    const group = create();

    expect(group.ownerId).toBe('ada');
    expect(group.members).toEqual([{ accountId: 'ada', role: 'owner' }]);
    expect(group.version).toBe(0);
    const [event] = group.pullDomainEvents();
    expect(event).toBeInstanceOf(GroupCreatedEvent);
    expect(event.payload).toEqual({ groupId: group.id, name: 'Lisbon', currency: 'EUR', ownerId: 'ada' });
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('refuses a name or a currency the rules refuse, and records nothing', () => {
    const badName = Group.register({ name: '  ', currency: 'EUR', ownerId: 'ada', at: AT });
    const badCurrency = Group.register({ name: 'Lisbon', currency: 'JPY', ownerId: 'ada', at: AT });

    expect(badName.error).toBeInstanceOf(InvalidGroupNameException);
    expect(badCurrency.error).toBeInstanceOf(InvalidCurrencyException);
  });

  it('round-trips through its snapshot, recording nothing', () => {
    const snapshot = { ...create().toSnapshot(), version: 3 };

    const group = Group.fromSnapshot(snapshot);

    expect(group.toSnapshot()).toEqual(snapshot);
    expect(group.version).toBe(3);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('refuses a snapshot whose owner is not its first member', () => {
    const snapshot = create().toSnapshot();

    expect(() => Group.fromSnapshot({ ...snapshot, members: [{ accountId: 'bob', role: 'owner' }] })).toThrow(
      /corrupted/,
    );
  });
});
