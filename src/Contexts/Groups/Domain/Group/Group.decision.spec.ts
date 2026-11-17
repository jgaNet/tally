import { decideCreateGroup, CreateGroupCommand } from './Group.decision';
import { GroupCreatedEvent } from './GroupEvents';

const at = new Date('2026-04-01T09:00:00.000Z');
const createWith = (overrides: Partial<CreateGroupCommand> = {}): CreateGroupCommand => ({
  name: 'Lisbon trip',
  currency: 'EUR',
  ownerId: '3c9d2f1e-0000-4000-8000-000000000001',
  ...overrides,
});

describe('decideCreateGroup', () => {
  it('makes the group, owned by its creator, and records its creation', () => {
    const decision = decideCreateGroup(undefined, createWith(), at);

    expect(decision.isSuccess()).toBe(true);
    const group = decision.data!.state;
    expect(group.name.value).toBe('Lisbon trip');
    expect(group.currency.value).toBe('EUR');
    expect(group.ownerId).toBe('3c9d2f1e-0000-4000-8000-000000000001');
    expect(group._id.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(group.pullDomainEvents()).toEqual([
      GroupCreatedEvent.set({
        groupId: group._id.value,
        ownerId: '3c9d2f1e-0000-4000-8000-000000000001',
        createdAt: at,
      }),
    ]);
  });

  it('trims the name', () => {
    const decision = decideCreateGroup(undefined, createWith({ name: '  Climbing club  ' }), at);
    expect(decision.data!.state.name.value).toBe('Climbing club');
  });

  it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts the currency %s', currency => {
    expect(decideCreateGroup(undefined, createWith({ currency }), at).isSuccess()).toBe(true);
  });

  it.each(['JPY', 'eur', '', 'EURO'])('refuses the currency %j, which is not one of the six', currency => {
    const decision = decideCreateGroup(undefined, createWith({ currency }), at);
    expect(decision.isFailure() && decision.error.type).toBe('InvalidCurrency');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['61 characters', 'a'.repeat(61)],
  ])('refuses a name that is %s', (_label, name) => {
    const decision = decideCreateGroup(undefined, createWith({ name }), at);
    expect(decision.isFailure() && decision.error.type).toBe('InvalidGroupName');
  });

  it('accepts a name of 60 characters', () => {
    expect(decideCreateGroup(undefined, createWith({ name: 'a'.repeat(60) }), at).isSuccess()).toBe(true);
  });
});
