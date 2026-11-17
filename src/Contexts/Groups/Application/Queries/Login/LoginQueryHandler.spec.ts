import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';
import { SignUpCommandHandler } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandHandler';
import { LoginQueryHandler } from '@Contexts/Groups/Application/Queries/Login/LoginQueryHandler';
import { HmacTokenIssuer } from '@Contexts/Groups/Infrastructure/HmacTokenIssuer';
import { InMemoryAccountReadModels, InMemoryAccountRepository } from '@Contexts/Groups/Infrastructure/InMemoryAccounts';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const context = new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const now = new Date('2026-03-01T10:00:00Z');
const store = new Map();
const hasher = new ScryptPasswordHasher();
const tokens = new HmacTokenIssuer('a secret');
const login = new LoginQueryHandler(new InMemoryAccountReadModels(store), hasher, tokens, () => now);
let accountId: string;

beforeAll(async () => {
  const signUp = new SignUpCommandHandler(new InMemoryAccountRepository(store), hasher);
  const result = await signUp.execute(
    SignUpCommandEvent.set({ email: 'alice@example.com', password: 'correct horse', name: 'Alice' }),
    context,
  );
  accountId = result.data as string;
});

describe('Login', () => {
  it('answers a token naming the account, for the right password, whatever the email case', async () => {
    const result = await login.execute({ email: 'Alice@Example.COM', password: 'correct horse' }, context);

    expect(tokens.verify(result.data as string, now)).toBe(accountId);
  });

  it('refuses a wrong password and an unknown email with the same refusal', async () => {
    const wrong = await login.execute({ email: 'alice@example.com', password: 'wrong horse' }, context);
    const unknown = await login.execute({ email: 'bob@example.com', password: 'correct horse' }, context);
    const malformed = await login.execute({ email: 'bob', password: 'correct horse' }, context);

    for (const refused of [wrong, unknown, malformed]) {
      expect(refused.isFailure() && refused.error).toEqual(wrong.error);
    }
    expect(wrong.isFailure() && wrong.error.type).toBe('InvalidCredentials');
  });
});

describe('the token', () => {
  it('proves nothing once altered, signed by another secret, or expired', () => {
    const token = tokens.issue('someone', now);

    expect(tokens.verify(token, now)).toBe('someone');
    expect(tokens.verify(`${token}x`, now)).toBeNull();
    expect(tokens.verify(tokens.issue('someone', now).replace(/^[^.]+/, 'eyJzdWIiOiJvdGhlciJ9'), now)).toBeNull();
    expect(new HmacTokenIssuer('another secret').verify(token, now)).toBeNull();
    expect(tokens.verify(token, new Date(now.getTime() + HmacTokenIssuer.LIFETIME_MS + 1))).toBeNull();
    expect(tokens.verify('garbage', now)).toBeNull();
  });
});
