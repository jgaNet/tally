import { describe, expect, it, jest, beforeEach } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';
import { InMemoryAccountStore } from '@Contexts/Groups/Infrastructure/InMemoryAccountStore';
import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';

/** The use cases of the accounts, over the in-memory store and the real password and token adapters. */
const now = new Date('2026-05-01T10:00:00.000Z');
const clock = () => now;

let store: InMemoryAccountStore;
let passwords: ScryptPasswordHasher;
let tokens: SignedSessionTokens;
let context: (auth?: { subjectId?: string; role?: string }) => ExecutionContext;

beforeEach(() => {
  store = new InMemoryAccountStore();
  passwords = new ScryptPasswordHasher();
  tokens = new SignedSessionTokens('a test key');
  const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as unknown as EventBus;
  context = (auth = {}) => new ExecutionContext({ traceId: 'trace', eventBus, auth });
});

const ann = { email: 'ann@example.com', password: 'a long enough password', name: 'Ann' };
const signedUp = (input = ann) => signUp(store, passwords, clock).run(input, context());

describe('signUp', () => {
  it('answers the new account id, and keeps the account with a hash of the password, not the password', async () => {
    const result = await signedUp();

    expect(result.isSuccess()).toBe(true);
    const [kept] = [...store.accounts.values()];
    expect(kept).toMatchObject({ id: result.data, email: 'ann@example.com', name: 'Ann' });
    expect(kept.passwordHash).not.toContain(ann.password);
    expect(await passwords.matches(ann.password, kept.passwordHash)).toBe(true);
  });

  it('refuses an email already used, whatever its case, and keeps only the first account', async () => {
    await signedUp();
    const again = await signedUp({ ...ann, email: 'ANN@example.com' });

    expect(again.isFailure() && again.error.type).toBe('EmailAlreadyRegistered');
    expect(store.accounts.size).toBe(1);
  });

  it('refuses what the rules refuse, and keeps nothing', async () => {
    expect((await signedUp({ ...ann, password: 'short' })).isFailure()).toBe(true);
    expect((await signedUp({ ...ann, name: '  ' })).isFailure()).toBe(true);
    expect((await signedUp({ ...ann, email: 'nope' })).isFailure()).toBe(true);
    expect(store.accounts.size).toBe(0);
  });
});

describe('signIn', () => {
  it('answers a token that proves the account, for the right password', async () => {
    const { data: id } = await signedUp();
    const answer = await signIn(store, passwords, tokens).run({ email: ann.email, password: ann.password }, context());

    expect(answer.isSuccess()).toBe(true);
    expect(tokens.accountOf(answer.data!.token)).toBe(id);
  });

  it('refuses a wrong password and an unknown email with the same answer', async () => {
    await signedUp();
    const wrong = await signIn(store, passwords, tokens).run(
      { email: ann.email, password: 'not it at all' },
      context(),
    );
    const unknown = await signIn(store, passwords, tokens).run(
      { email: 'nobody@example.com', password: ann.password },
      context(),
    );

    expect(wrong.isFailure() && wrong.error.type).toBe('InvalidCredentials');
    expect(unknown.isFailure() && unknown.error.type).toBe('InvalidCredentials');
    expect(wrong.isFailure() && unknown.isFailure() && wrong.error.message === unknown.error.message).toBe(true);
  });
});

describe('getMyAccount', () => {
  it('answers the signed-in person’s own account', async () => {
    const { data: id } = await signedUp();
    const answer = await getMyAccount(store).run(undefined, context({ subjectId: id, role: 'USER' }));

    expect(answer.data).toEqual({ id, email: 'ann@example.com', name: 'Ann' });
  });

  it('refuses an account that is not there with not found', async () => {
    const answer = await getMyAccount(store).run(undefined, context({ subjectId: 'no-such-account', role: 'USER' }));
    expect(answer.isFailure() && answer.error.type).toBe('NotFound');
  });
});
