import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';
import { SignUpCommandHandler } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandHandler';
import { InMemoryAccountReadModels, InMemoryAccountRepository } from '@Contexts/Groups/Infrastructure/InMemoryAccounts';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const setup = () => {
  const store = new Map();
  return {
    readModels: new InMemoryAccountReadModels(store),
    handler: new SignUpCommandHandler(new InMemoryAccountRepository(store), new ScryptPasswordHasher()),
  };
};
const signUp = (payload: Partial<{ email: string; password: string; name: string }> = {}) =>
  SignUpCommandEvent.set({ email: 'alice@example.com', password: 'correct horse', name: 'Alice', ...payload });

describe('SignUp', () => {
  it('may be asked by anyone', () => {
    expect(setup().handler.anyoneMayAsk()).toBe(true);
  });

  it('creates the account and answers its id; the password is kept hashed', async () => {
    const { handler, readModels } = setup();

    const result = await handler.execute(signUp(), anonymous());

    expect(result.isSuccess()).toBe(true);
    expect(await readModels.findById(result.data as string)).toEqual({
      id: result.data,
      email: 'alice@example.com',
      name: 'Alice',
    });
    expect((await readModels.findByEmail('alice@example.com'))?.passwordHash).not.toContain('correct horse');
  });

  it.each([
    ['an email that does not look like one', { email: 'alice.example.com' }, 'InvalidEmailFormat'],
    ['a password under 8 characters', { password: '1234567' }, 'PasswordTooShort'],
    ['a name of only spaces', { name: '   ' }, 'InvalidName'],
    ['a name over 60 characters', { name: 'x'.repeat(61) }, 'InvalidName'],
  ])('refuses %s', async (_, payload, type) => {
    const result = await setup().handler.execute(signUp(payload), anonymous());

    expect(result.isFailure() && result.error.type).toBe(type);
  });

  it('refuses an email an account already uses, whatever its case', async () => {
    const { handler } = setup();
    await handler.execute(signUp(), anonymous());

    const again = await handler.execute(signUp({ email: ' ALICE@Example.com ', name: 'Other' }), anonymous());

    expect(again.isFailure() && again.error.type).toBe('EmailAlreadyUsed');
  });
});
