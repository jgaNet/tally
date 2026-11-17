import { describe, expect, it } from '@jest/globals';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Group';

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
      memberIds: [owner],
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

describe('Group.fromSnapshot', () => {
  it('rebuilds the group it was saved as, records nothing, and keeps its version', () => {
    const snapshot = {
      id: 'g-1',
      name: 'Flat',
      currency: 'GBP',
      ownerId: owner,
      memberIds: [owner],
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
        memberIds: ['someone-else'],
        createdAt: now.toISOString(),
        version: 0,
      }),
    ).toThrow(/corrupted/);
  });
});
