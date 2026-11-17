import { describe, expect, it } from '@jest/globals';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  BalancePassedEvent,
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Group';

/** A group's creation, its name and currency as the domain keeps them, and the fact it records (ADR 5). */
const now = new Date('2026-05-01T10:00:00.000Z');
const owner = 'account-ann';
const draft = { name: 'Lisbon trip', currency: 'EUR', ownerId: owner };

describe('Group.register', () => {
  it('makes the owner its first and only member, in the currency given, and records GroupCreated', () => {
    const result = Group.register(draft, now);

    expect(result.isSuccess()).toBe(true);
    const group = result.data!;
    expect(group.toSnapshot()).toEqual({
      id: expect.any(String),
      name: 'Lisbon trip',
      currency: 'EUR',
      ownerId: owner,
      members: [{ accountId: owner, joinedAt: '2026-05-01T10:00:00.000Z' }],
      formerMembers: [],
      passes: [],
      createdAt: '2026-05-01T10:00:00.000Z',
      version: 0,
    });
    const [recorded] = group.pullDomainEvents();
    expect(recorded).toBeInstanceOf(GroupCreatedEvent);
    expect(recorded.payload).toEqual({
      groupId: group.toSnapshot().id,
      createdBy: owner,
      at: '2026-05-01T10:00:00.000Z',
    });
  });

  it.each(Currency.CODES)('accepts %s, and only the six codes', code => {
    expect(Group.register({ ...draft, currency: code }, now).isSuccess()).toBe(true);
  });

  it.each([
    ['a code that is not one of the six', 'JPY', 'UnsupportedCurrency'],
    ['a code in lower case', 'eur', 'UnsupportedCurrency'],
    ['an empty currency', '', 'UnsupportedCurrency'],
  ])('refuses %s, and records nothing', (_, currency, type) => {
    const result = Group.register({ ...draft, currency }, now);
    expect(result.isFailure() && result.error.type).toBe(type);
  });

  it.each([
    ['an empty name', ''],
    ['a name of only spaces', '   '],
    ['a name over 60 characters', 'x'.repeat(61)],
  ])('refuses %s with InvalidGroupName', (_, name) => {
    const result = Group.register({ ...draft, name }, now);
    expect(result.isFailure() && result.error.type).toBe('InvalidGroupName');
  });

  it('accepts a name of exactly 60 characters', () => {
    expect(GroupName.create('x'.repeat(60)).isSuccess()).toBe(true);
  });

  it('generates a new identity for each group', () => {
    const first = Group.register(draft, now).data!.toSnapshot().id;
    const second = Group.register(draft, now).data!.toSnapshot().id;
    expect(first).not.toBe(second);
  });
});

describe('Group.join', () => {
  const later = new Date('2026-05-02T09:30:00.000Z');

  it('adds the account as the last member, at the time given, and records MemberJoined', () => {
    const group = Group.register(draft, now).data!;
    group.pullDomainEvents();

    expect(group.join('account-bob', later).isSuccess()).toBe(true);
    expect(group.members()).toEqual([
      { accountId: owner, joinedAt: now.toISOString() },
      { accountId: 'account-bob', joinedAt: later.toISOString() },
    ]);
    expect(group.hasMember('account-bob')).toBe(true);
    const [recorded] = group.pullDomainEvents();
    expect(recorded).toBeInstanceOf(MemberJoinedEvent);
    expect(recorded.payload).toEqual({
      groupId: group.toSnapshot().id,
      accountId: 'account-bob',
      at: later.toISOString(),
    });
  });

  it('refuses an account that is already a member, with AlreadyMember, and changes nothing', () => {
    const group = Group.register(draft, now).data!;
    group.pullDomainEvents();

    const again = group.join(owner, later);
    expect(again.isFailure() && again.error.type).toBe('AlreadyMember');
    expect(group.members()).toHaveLength(1);
    expect(group.pullDomainEvents()).toEqual([]);
  });
});

describe('Group.fromSnapshot', () => {
  it('rebuilds the group it was saved as, records nothing, and keeps its version', () => {
    const snapshot = {
      id: 'g-1',
      name: 'Flat',
      currency: 'GBP',
      ownerId: owner,
      members: [{ accountId: owner, joinedAt: now.toISOString() }],
      formerMembers: [],
      passes: [],
      createdAt: now.toISOString(),
      version: 3,
    };
    const group = Group.fromSnapshot(snapshot);

    expect(group.toSnapshot()).toEqual(snapshot);
    expect(group.version).toBe(3);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('throws on a snapshot whose owner is not its first member', () => {
    expect(() =>
      Group.fromSnapshot({
        id: 'g-2',
        name: 'Flat',
        currency: 'GBP',
        ownerId: owner,
        members: [{ accountId: 'someone-else', joinedAt: now.toISOString() }],
        formerMembers: [],
        passes: [],
        createdAt: now.toISOString(),
        version: 0,
      }),
    ).toThrow(/corrupted/);
  });
});

describe('Group.leave', () => {
  const later = new Date('2026-05-02T09:30:00.000Z');
  const latest = new Date('2026-05-03T18:00:00.000Z');
  const bob = 'account-bob';
  const settled = { balance: 0, paymentWaiting: false };

  /** A group with the owner and Bob, who joined at `later`; its recorded facts taken away. */
  const withBob = () => {
    const group = Group.register(draft, now).data!;
    group.join(bob, later);
    group.pullDomainEvents();
    return group;
  };

  it('takes a member with a balance of 0 out of the members, keeps them as a former member, and records MemberLeft', () => {
    const group = withBob();

    expect(group.leave(bob, settled, latest).isSuccess()).toBe(true);
    expect(group.members().map(member => member.accountId)).toEqual([owner]);
    expect(group.hasMember(bob)).toBe(false);
    expect(group.formerMembers()).toEqual([
      { accountId: bob, joinedAt: later.toISOString(), leftAt: latest.toISOString() },
    ]);
    const [, recorded] = group.pullDomainEvents();
    expect(recorded).toBeInstanceOf(MemberLeftEvent);
    expect(recorded.payload).toEqual({
      groupId: group.toSnapshot().id,
      accountId: bob,
      at: latest.toISOString(),
    });
  });

  it('lets a member leave whatever their balance: it passes to the owner in the same step, BalancePassed beside MemberLeft', () => {
    const group = withBob();

    expect(group.leave(bob, { balance: -250, paymentWaiting: false }, latest).isSuccess()).toBe(true);
    expect(group.hasMember(bob)).toBe(false);
    expect(group.passes()).toEqual([
      { fromAccountId: bob, toAccountId: owner, amount: -250, at: latest.toISOString() },
    ]);
    const [passed, left] = group.pullDomainEvents();
    expect(passed).toBeInstanceOf(BalancePassedEvent);
    expect(passed.payload).toEqual({
      groupId: group.toSnapshot().id,
      fromAccountId: bob,
      toAccountId: owner,
      amount: -250,
      at: latest.toISOString(),
    });
    expect(left).toBeInstanceOf(MemberLeftEvent);
  });

  it('refuses a member with a payment waiting at the provider, with PaymentWaiting, and changes nothing', () => {
    const group = withBob();

    const refused = group.leave(bob, { balance: 0, paymentWaiting: true }, latest);
    expect(refused.isFailure() && refused.error.type).toBe('PaymentWaiting');
    expect(group.hasMember(bob)).toBe(true);
    expect(group.formerMembers()).toEqual([]);
    expect(group.passes()).toEqual([]);
    expect(group.pullDomainEvents()).toEqual([]);
  });

  it('refuses the owner, whatever the balance, with OwnerCannotLeave', () => {
    const group = withBob();

    const refused = group.leave(owner, settled, latest);
    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
    expect(group.hasMember(owner)).toBe(true);
  });

  it('refuses an account that is not a member, as the group is not there for it', () => {
    const group = withBob();

    const refused = group.leave('account-carol', settled, latest);
    expect(refused.isFailure() && refused.error.type).toBe('NotFound');
  });

  it('keeps the passes of every leave, and a member who joined again keeps what they passed', () => {
    const group = withBob();
    group.leave(bob, { balance: 40, paymentWaiting: false }, latest);
    group.join(bob, new Date('2026-05-04T08:00:00.000Z'));
    group.leave(bob, { balance: -15, paymentWaiting: false }, new Date('2026-05-05T08:00:00.000Z'));

    expect(group.passes().map(pass => pass.amount)).toEqual([40, -15]);
    expect(group.toSnapshot().passes).toEqual(group.passes());
  });

  it('makes a member who joined again the last of the members, with the time they joined again', () => {
    const group = withBob();
    group.leave(bob, settled, latest);
    group.pullDomainEvents();
    const again = new Date('2026-05-04T08:00:00.000Z');

    expect(group.join(bob, again).isSuccess()).toBe(true);
    expect(group.members()).toEqual([
      { accountId: owner, joinedAt: now.toISOString() },
      { accountId: bob, joinedAt: again.toISOString() },
    ]);
    expect(group.formerMembers()).toEqual([]);
  });
});
