import { EventEmitter } from 'events';

import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { Role } from '@SharedKernel/Domain';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { ISessionTokens } from '@Contexts/Groups/Application/Ports/ISessionTokens';
import { InMemoryAccountRepository } from '@Contexts/Groups/Infrastructure/InMemoryAccountRepository';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import {
  EmailAlreadyUsedException,
  InvalidAccountNameException,
  PasswordTooShortException,
} from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { InvalidEmailFormat } from '@SharedKernel/Domain/Email';
import { NotAllowedException, NotFoundException } from '@Architecture/Domain';

/**
 * The tokens the use cases answer: a token names its account, and nothing else. The signed tokens, under the key the
 * database keeps, are tested with their adapter (Infrastructure/PostgresSessionTokens.spec.ts).
 */
class TokensOfTheSpec implements ISessionTokens {
  issue(accountId: string, role: Role): string {
    return `token-of-${accountId}-${role}`;
  }

  accountOf(token: string): { subjectId: string; role: Role } | undefined {
    const match = /^token-of-(.+)-(ADMIN|USER|GUEST)$/.exec(token);
    return match ? { subjectId: match[1], role: match[2] as Role } : undefined;
  }
}

/** The use cases, run as the transport runs them: their ports, and an execution context with no file under it. */
function setUp() {
  const accounts = new InMemoryAccountRepository();
  const passwords = new ScryptPasswordHasher();
  const tokens = new TokensOfTheSpec();
  const context = (subjectId?: string) =>
    new ExecutionContext({
      traceId: 'trace',
      auth: subjectId ? { subjectId, role: Role.USER } : {},
      eventBus: new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => new Date() }),
    });
  return {
    accounts,
    context,
    register: signUp(accounts, passwords),
    logIn: signIn(accounts, passwords, tokens, () => []),
    readMine: getMyAccount({ findAccount: async id => toView(id, accounts) }),
    tokens,
  };
}

function toView(id: string, accounts: InMemoryAccountRepository) {
  const account = accounts.accounts.get(id);
  return account && { id: account.id, email: account.email, name: account.name };
}

const SIGN_UP = { email: 'ada@example.com', password: 'a-good-password', name: 'Ada' };

describe('signing up', () => {
  it('stores the account, with its password hashed, and answers its id', async () => {
    const { register, accounts, context } = setUp();

    const result = await register.run(SIGN_UP, context());

    expect(result.isSuccess()).toBe(true);
    const stored = accounts.accounts.get(result.data as string);
    expect(stored?.email).toBe('ada@example.com');
    expect(stored?.passwordHash).not.toContain('a-good-password');
  });

  it('refuses an email already used, whatever its case', async () => {
    const { register, context } = setUp();
    await register.run(SIGN_UP, context());

    const again = await register.run({ ...SIGN_UP, email: 'ADA@Example.com' }, context());

    expect(again.isFailure()).toBe(true);
    expect(again.error).toBeInstanceOf(EmailAlreadyUsedException);
  });

  it.each([
    ['an email that does not look like one', { email: 'ada' }, InvalidEmailFormat],
    ['a password of 7 characters', { password: '1234567' }, PasswordTooShortException],
    ['a name of only spaces', { name: '   ' }, InvalidAccountNameException],
    ['a name longer than 60 characters', { name: 'x'.repeat(61) }, InvalidAccountNameException],
  ])('refuses %s', async (_, change, refusal) => {
    const { register, context } = setUp();

    const result = await register.run({ ...SIGN_UP, ...change }, context());

    expect(result.isFailure()).toBe(true);
    expect(result.error).toBeInstanceOf(refusal);
  });
});

describe('signing in', () => {
  it('answers a token for the right password, which proves the account', async () => {
    const { register, logIn, tokens, context } = setUp();
    const id = (await register.run(SIGN_UP, context())).data as string;

    const result = await logIn.run({ email: 'ADA@example.com', password: 'a-good-password' }, context());

    expect(result.isSuccess()).toBe(true);
    expect(tokens.accountOf((result.data as { token: string }).token)?.subjectId).toBe(id);
  });

  it('refuses a wrong password and an unknown email the same way', async () => {
    const { register, logIn, context } = setUp();
    await register.run(SIGN_UP, context());

    const wrongPassword = await logIn.run({ email: SIGN_UP.email, password: 'not-the-password' }, context());
    const unknownEmail = await logIn.run({ email: 'nobody@example.com', password: 'a-good-password' }, context());

    expect(wrongPassword.error).toBeInstanceOf(NotAllowedException);
    expect(unknownEmail.error).toBeInstanceOf(NotAllowedException);
    expect(wrongPassword.error?.message).toBe(unknownEmail.error?.message);
  });
});

describe('reading my account', () => {
  it('answers the caller’s own account, and nothing else', async () => {
    const { register, readMine, context } = setUp();
    const id = (await register.run(SIGN_UP, context())).data as string;

    const result = await readMine.run(undefined, context(id));

    expect(result.data).toEqual({ id, email: 'ada@example.com', name: 'Ada' });
  });

  it('answers not found for a caller with no account', async () => {
    const { readMine, context } = setUp();

    const result = await readMine.run(undefined, context('no-such-account'));

    expect(result.error).toBeInstanceOf(NotFoundException);
  });
});
