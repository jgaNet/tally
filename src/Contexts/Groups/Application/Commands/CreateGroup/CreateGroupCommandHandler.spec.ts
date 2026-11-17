import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';
import { CreateGroupCommandHandler } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandHandler';
import { InMemoryGroupReadModels, InMemoryGroupRepository } from '@Contexts/Groups/Infrastructure/InMemoryGroups';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const at = new Date('2026-03-01T10:00:00.000Z');
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const setup = () => {
  const store = new Map();
  return {
    readModels: new InMemoryGroupReadModels(store),
    handler: new CreateGroupCommandHandler(new InMemoryGroupRepository(store), () => at),
  };
};
const createGroup = (payload: Partial<{ name: string; currency: string }> = {}) =>
  CreateGroupCommandEvent.set({ name: 'Lisbon', currency: 'EUR', ...payload });

describe('CreateGroup', () => {
  it('may not be asked by anyone who is not signed in', () => {
    expect(setup().handler.anyoneMayAsk(createGroup())).toBe(false);
  });

  it('creates the group owned by its creator, who is its first member, and answers its id', async () => {
    const { handler, readModels } = setup();

    const result = await handler.execute(createGroup(), signedInAs('alice'));

    expect(result.isSuccess()).toBe(true);
    expect(await readModels.findForMember(result.data as string, 'alice')).toEqual({
      id: result.data,
      name: 'Lisbon',
      currency: 'EUR',
      ownerId: 'alice',
    });
  });

  it('refuses a group to someone who is not signed in', async () => {
    const result = await setup().handler.execute(createGroup(), anonymous());

    expect(result.isFailure() && result.error.type).toBe('NotAllowed');
  });

  it.each([
    ['a name of only spaces', { name: '   ' }, 'InvalidGroupName'],
    ['a name over 60 characters', { name: 'x'.repeat(61) }, 'InvalidGroupName'],
    ['a currency not on the list', { currency: 'JPY' }, 'InvalidCurrency'],
  ])('refuses %s', async (_, payload, type) => {
    const result = await setup().handler.execute(createGroup(payload), signedInAs('alice'));

    expect(result.isFailure() && result.error.type).toBe(type);
  });
});
