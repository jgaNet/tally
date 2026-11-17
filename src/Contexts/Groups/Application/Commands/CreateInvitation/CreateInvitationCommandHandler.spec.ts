import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';
import { CreateGroupCommandHandler } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandHandler';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';
import { CreateInvitationCommandHandler } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandHandler';
import { InMemoryGroupRepository, InMemoryGroupStore } from '@Contexts/Groups/Infrastructure/InMemoryGroups';
import {
  InMemoryInvitationReadModels,
  InMemoryInvitationStore,
  InMemoryInvitationRepository,
} from '@Contexts/Groups/Infrastructure/InMemoryInvitations';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const at = new Date('2026-03-01T10:00:00.000Z');
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const setup = () => {
  const groupStore: InMemoryGroupStore = new Map();
  const invitationStore: InMemoryInvitationStore = new Map();
  const groups = new InMemoryGroupRepository(groupStore);
  return {
    groups,
    invitationStore,
    readModels: new InMemoryInvitationReadModels(invitationStore, groupStore),
    createGroup: new CreateGroupCommandHandler(groups, () => at),
    handler: new CreateInvitationCommandHandler(groups, new InMemoryInvitationRepository(invitationStore), () => at),
  };
};

describe('CreateInvitation', () => {
  it('may not be asked by anyone who is not signed in', () => {
    const { handler } = setup();

    expect(handler.anyoneMayAsk(CreateInvitationCommandEvent.set({ groupId: 'any' }))).toBe(false);
  });

  it('lets a member create an invitation, whose id is the link, and answers that id', async () => {
    const { createGroup, handler, readModels } = setup();
    const group = await createGroup.execute(
      CreateGroupCommandEvent.set({ name: 'Lisbon', currency: 'EUR' }),
      signedInAs('alice'),
    );

    const result = await handler.execute(
      CreateInvitationCommandEvent.set({ groupId: group.data as string }),
      signedInAs('alice'),
    );

    expect(result.isSuccess()).toBe(true);
    expect(await readModels.findById(result.data as string)).toEqual({
      id: result.data,
      groupId: group.data,
      groupName: 'Lisbon',
      invitedBy: 'alice',
    });
  });

  it('refuses an invitation to someone who is not a member, as if the group did not exist', async () => {
    const { createGroup, handler, invitationStore } = setup();
    const group = await createGroup.execute(
      CreateGroupCommandEvent.set({ name: 'Lisbon', currency: 'EUR' }),
      signedInAs('alice'),
    );

    const stranger = await handler.execute(
      CreateInvitationCommandEvent.set({ groupId: group.data as string }),
      signedInAs('bob'),
    );
    const missing = await handler.execute(CreateInvitationCommandEvent.set({ groupId: 'nope' }), signedInAs('alice'));

    expect(stranger.isFailure() && stranger.error.type).toBe('NotFound');
    expect(missing.isFailure() && missing.error.type).toBe('NotFound');
    expect(invitationStore.size).toBe(0);
  });

  it('refuses an invitation to someone who is not signed in', async () => {
    const { handler } = setup();

    const result = await handler.execute(CreateInvitationCommandEvent.set({ groupId: 'any' }), anonymous());

    expect(result.isFailure() && result.error.type).toBe('NotAllowed');
  });
});
