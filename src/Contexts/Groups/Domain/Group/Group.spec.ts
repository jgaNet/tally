import { Currency, CURRENCIES } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  InvalidCurrencyException,
  InvalidGroupNameException,
  OwnerCannotLeaveException,
  PaymentWaitingException,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import {
  BalancePassedEvent,
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

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
    expect(group.members).toEqual([{ accountId: 'ada', role: 'owner', joinedAt: AT.toISOString() }]);
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

    expect(() =>
      Group.fromSnapshot({ ...snapshot, members: [{ accountId: 'bob', role: 'owner', joinedAt: AT.toISOString() }] }),
    ).toThrow(/corrupted/);
  });

  it('adds a member to the end of its members, once, recording MemberJoined', () => {
    const group = create();
    group.pullDomainEvents();
    const later = new Date('2026-05-02T09:30:00.000Z');

    expect(group.join({ accountId: 'bob', at: later }).isSuccess()).toBe(true);

    expect(group.members).toEqual([
      { accountId: 'ada', role: 'owner', joinedAt: AT.toISOString() },
      { accountId: 'bob', role: 'member', joinedAt: later.toISOString() },
    ]);
    expect(group.isMember('bob')).toBe(true);
    const [event] = group.pullDomainEvents();
    expect(event).toBeInstanceOf(MemberJoinedEvent);
    expect(event.payload).toEqual({ groupId: group.id, accountId: 'bob' });
  });

  it('refuses a member who joins again, and records nothing', () => {
    const group = create();
    group.pullDomainEvents();

    const again = group.join({ accountId: 'ada', at: AT });

    expect(again.error?.type).toBe('AlreadyExists');
    expect(group.members).toHaveLength(1);
    expect(group.pullDomainEvents()).toEqual([]);
  });
});

describe('Group leaving (request 9)', () => {
  const create = () => Group.register({ name: 'Lisbon', currency: 'EUR', ownerId: 'ada', at: AT }).data!;
  const JOINED = new Date('2026-05-02T09:30:00.000Z');
  const LEFT = new Date('2026-05-03T18:00:00.000Z');
  const AGAIN = new Date('2026-05-04T08:00:00.000Z');

  it('takes a member out, keeps it as a former member, and records what passed and MemberLeft', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.pullDomainEvents();

    expect(group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: LEFT }).isSuccess()).toBe(true);

    expect(group.isMember('bob')).toBe(false);
    expect(group.members).toEqual([{ accountId: 'ada', role: 'owner', joinedAt: AT.toISOString() }]);
    expect(group.toSnapshot().members).toContainEqual({
      accountId: 'bob',
      role: 'member',
      joinedAt: JOINED.toISOString(),
      leftAt: LEFT.toISOString(),
    });
    const [passed, left] = group.pullDomainEvents();
    expect(passed).toBeInstanceOf(BalancePassedEvent);
    expect(passed.payload).toEqual({ groupId: group.id, from: 'bob', to: 'ada', amount: 0 });
    expect(left).toBeInstanceOf(MemberLeftEvent);
    expect(left.payload).toEqual({ groupId: group.id, accountId: 'bob' });
  });

  it('lets a member leave at any balance, which passes to the owner in the same step', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.pullDomainEvents();

    expect(group.leave({ accountId: 'bob', balance: -300, waitingPayment: false, at: LEFT }).isSuccess()).toBe(true);

    const [passed, left] = group.pullDomainEvents();
    expect(passed.payload).toEqual({ groupId: group.id, from: 'bob', to: 'ada', amount: -300 });
    expect(left).toBeInstanceOf(MemberLeftEvent);
    expect(group.toSnapshot().members).toContainEqual(
      expect.objectContaining({ accountId: 'bob', leftAt: LEFT.toISOString(), passed: -300 }),
    );
  });

  it('starts a member who joins again at 0: what its earlier leaves passed stays on it', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.leave({ accountId: 'bob', balance: -300, waitingPayment: false, at: LEFT });
    group.join({ accountId: 'bob', at: AGAIN });
    group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: AGAIN });
    group.join({ accountId: 'bob', at: AGAIN });
    group.leave({ accountId: 'bob', balance: 120, waitingPayment: false, at: AGAIN });

    expect(group.toSnapshot().members).toContainEqual(expect.objectContaining({ accountId: 'bob', passed: -180 }));
  });

  it('refuses the leave while a payment of the member waits at the provider, and records nothing', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.pullDomainEvents();

    const refused = group.leave({ accountId: 'bob', balance: -250, waitingPayment: true, at: LEFT });

    expect(refused.error).toBeInstanceOf(PaymentWaitingException);
    expect(group.isMember('bob')).toBe(true);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('keeps the departure when the group is read back from its snapshot', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: LEFT });

    const read = Group.fromSnapshot(group.toSnapshot());

    expect(read.isMember('bob')).toBe(false);
    expect(read.members.map(member => member.accountId)).toEqual(['ada']);
  });

  it('refuses the owner, whatever its balance', () => {
    const group = create();

    expect(group.leave({ accountId: 'ada', balance: 0, waitingPayment: false, at: LEFT }).error).toBeInstanceOf(
      OwnerCannotLeaveException,
    );
    expect(group.isMember('ada')).toBe(true);
  });

  it('answers NotFound to an account that is not a current member, and to one that already left', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: LEFT });

    expect(group.leave({ accountId: 'cy', balance: 0, waitingPayment: false, at: LEFT }).error?.type).toBe('NotFound');
    expect(group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: LEFT }).error?.type).toBe('NotFound');
  });

  it('puts a former member last when it joins again, as a new member, with one entry for it', () => {
    const group = create();
    group.join({ accountId: 'bob', at: JOINED });
    group.join({ accountId: 'cy', at: JOINED });
    group.leave({ accountId: 'bob', balance: 0, waitingPayment: false, at: LEFT });

    expect(group.join({ accountId: 'bob', at: AGAIN }).isSuccess()).toBe(true);

    expect(group.members).toEqual([
      { accountId: 'ada', role: 'owner', joinedAt: AT.toISOString() },
      { accountId: 'cy', role: 'member', joinedAt: JOINED.toISOString() },
      { accountId: 'bob', role: 'member', joinedAt: AGAIN.toISOString() },
    ]);
    expect(group.toSnapshot().members.filter(member => member.accountId === 'bob')).toHaveLength(1);
  });
});
