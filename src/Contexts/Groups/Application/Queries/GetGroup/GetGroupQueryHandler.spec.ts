import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { GetGroupQueryHandler } from '@Contexts/Groups/Application/Queries/GetGroup/GetGroupQueryHandler';
import { InMemoryGroupReadModels } from '@Contexts/Groups/Infrastructure/InMemoryGroups';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const store = new Map([
  [
    'group-1',
    {
      id: 'group-1',
      name: 'Lisbon',
      currency: 'EUR',
      ownerId: 'alice',
      members: [
        { accountId: 'alice', joinedAt: '2026-03-01T10:00:00.000Z' },
        { accountId: 'bob', joinedAt: '2026-03-02T10:00:00.000Z' },
      ],
      departed: [],
      passages: [],
      createdAt: '2026-03-01T10:00:00.000Z',
      version: 2,
    },
  ],
]);

describe('GetGroup', () => {
  it('answers the group to one of its members', async () => {
    const result = await new GetGroupQueryHandler(new InMemoryGroupReadModels(store)).handle(
      { id: 'group-1' },
      signedInAs('bob'),
    );

    expect(result.isSuccess() && result.data).toEqual({
      id: 'group-1',
      name: 'Lisbon',
      currency: 'EUR',
      ownerId: 'alice',
    });
  });

  it('answers a signed-in stranger the same as a group that does not exist', async () => {
    const handler = new GetGroupQueryHandler(new InMemoryGroupReadModels(store));

    const stranger = await handler.handle({ id: 'group-1' }, signedInAs('carol'));
    const missing = await handler.handle({ id: 'nope' }, signedInAs('carol'));

    expect(stranger.isFailure() && stranger.error.type).toBe('NotFound');
    expect(missing.isFailure() && missing.error.type).toBe('NotFound');
  });

  it('refuses a caller who is not signed in', async () => {
    const result = await new GetGroupQueryHandler(new InMemoryGroupReadModels(store)).handle(
      { id: 'group-1' },
      anonymous(),
    );

    expect(result.isFailure() && result.error.type).toBe('NotAllowed');
  });
});
