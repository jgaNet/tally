import { CreateGroupCommand, decideCreateGroup } from './Group.decision';

const createWith = (overrides: Partial<CreateGroupCommand> = {}): CreateGroupCommand => ({
  name: 'Lisbon trip',
  currency: 'EUR',
  ...overrides,
});

describe('decideCreateGroup', () => {
  it('answers the validated name and currency', () => {
    const decision = decideCreateGroup(undefined, createWith(), new Date());
    expect(decision.isSuccess()).toBe(true);
    expect(decision.data!.state.name.value).toBe('Lisbon trip');
    expect(decision.data!.state.currency.value).toBe('EUR');
  });

  it('trims the name', () => {
    const decision = decideCreateGroup(undefined, createWith({ name: '  Climbing club  ' }), new Date());
    expect(decision.data!.state.name.value).toBe('Climbing club');
  });

  it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts the currency %s', currency => {
    expect(decideCreateGroup(undefined, createWith({ currency }), new Date()).isSuccess()).toBe(true);
  });

  it.each(['JPY', 'eur', '', 'EURO'])('refuses the currency %j, which is not one of the six', currency => {
    const decision = decideCreateGroup(undefined, createWith({ currency }), new Date());
    expect(decision.isFailure() && decision.error.type).toBe('InvalidCurrency');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['61 characters', 'a'.repeat(61)],
  ])('refuses a name that is %s', (_label, name) => {
    const decision = decideCreateGroup(undefined, createWith({ name }), new Date());
    expect(decision.isFailure() && decision.error.type).toBe('InvalidGroupName');
  });

  it('accepts a name of 60 characters', () => {
    expect(decideCreateGroup(undefined, createWith({ name: 'a'.repeat(60) }), new Date()).isSuccess()).toBe(true);
  });
});
