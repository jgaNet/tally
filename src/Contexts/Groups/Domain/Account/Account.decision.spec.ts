import { Email } from '@SharedKernel/Domain';

import { Account } from './Account';
import { decideSignIn, decideSignUp, SignUpCommand } from './Account.decision';
import { AccountRegisteredEvent } from './AccountEvents';

const at = new Date('2026-03-01T10:00:00.000Z');
const signUpWith = (overrides: Partial<SignUpCommand> = {}): SignUpCommand => ({
  email: Email.create('Ada@Example.org').data!,
  password: 'correct horse',
  passwordHash: 'hash',
  name: 'Ada',
  ...overrides,
});

describe('decideSignUp', () => {
  it('makes the account, with its id, and records its registration', () => {
    const decision = decideSignUp(undefined, signUpWith(), at);

    expect(decision.isSuccess()).toBe(true);
    const account = decision.data!.state;
    expect(account.email.value).toBe('ada@example.org');
    expect(account.name.value).toBe('Ada');
    expect(account.passwordHash).toBe('hash');
    expect(account._id.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.pullDomainEvents()).toEqual([
      AccountRegisteredEvent.set({ accountId: account._id.value, registeredAt: at }),
    ]);
  });

  it('refuses an email another account holds, whatever its case', () => {
    const existing = Account.fromSnapshot({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      email: 'ada@example.org',
      name: 'Ada',
      passwordHash: 'x',
    });
    const decision = decideSignUp(existing, signUpWith(), at);
    expect(decision.isFailure() && decision.error.type).toBe('EmailAlreadyUsed');
  });

  it('refuses a password of fewer than 8 characters', () => {
    const decision = decideSignUp(undefined, signUpWith({ password: 'short' }), at);
    expect(decision.isFailure() && decision.error.type).toBe('InvalidPassword');
  });

  it('accepts a password of exactly 8 characters', () => {
    expect(decideSignUp(undefined, signUpWith({ password: '12345678' }), at).isSuccess()).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['61 characters', 'a'.repeat(61)],
  ])('refuses a name that is %s', (_label, name) => {
    const decision = decideSignUp(undefined, signUpWith({ name }), at);
    expect(decision.isFailure() && decision.error.type).toBe('InvalidAccountName');
  });

  it('accepts a name of 60 characters', () => {
    expect(decideSignUp(undefined, signUpWith({ name: 'a'.repeat(60) }), at).isSuccess()).toBe(true);
  });
});

describe('decideSignIn', () => {
  const account = Account.fromSnapshot({
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    email: 'ada@example.org',
    name: 'Ada',
    passwordHash: 'hash',
  });

  it('answers the account when the password matches', () => {
    const decision = decideSignIn(account, { passwordMatches: true });
    expect(decision.isSuccess() && decision.data.state.equals(account)).toBe(true);
  });

  it('refuses a wrong password and an unknown email with the same answer', () => {
    const wrong = decideSignIn(account, { passwordMatches: false });
    const unknown = decideSignIn(undefined, { passwordMatches: false });
    expect(wrong.isFailure() && wrong.error.type).toBe('NotAllowed');
    expect(unknown.isFailure() && unknown.error.message).toBe(wrong.isFailure() && wrong.error.message);
  });
});
