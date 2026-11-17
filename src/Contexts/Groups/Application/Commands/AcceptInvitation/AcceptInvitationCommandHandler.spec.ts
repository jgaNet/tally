import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandEvent';
import { AcceptInvitationCommandHandler } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandHandler';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';
import { CreateGroupCommandHandler } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandHandler';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';
import { CreateInvitationCommandHandler } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandHandler';
import {
  InMemoryGroupRepository,
  InMemoryGroupStore,
  InMemoryGroupReadModels,
} from '@Contexts/Groups/Infrastructure/InMemoryGroups';
import {
  InMemoryInvitationRepository,
  InMemoryInvitationStore,
} from '@Contexts/Groups/Infrastructure/InMemoryInvitations';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const at = new Date('2026-03-01T10:00:00.000Z');
const later = new Date('2026-03-02T10:00:00.000Z');
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

/** A group owned by alice, with an invitation to it: the stores the two commands share. */
const setup = async () => {
  const groupStore: InMemoryGroupStore = new Map();
  const invitationStore: InMemoryInvitationStore = new Map();
  const groups = new InMemoryGroupRepository(groupStore);
  const invitations = new InMemoryInvitationRepository(invitationStore);
  const group = await new CreateGroupCommandHandler(groups, () => at).execute(
    CreateGroupCommandEvent.set({ name: 'Lisbon', currency: 'EUR' }),
    signedInAs('alice'),
  );
  const invitation = await new CreateInvitationCommandHandler(groups, invitations, () => at).execute(
    CreateInvitationCommandEvent.set({ groupId: group.data as string }),
    signedInAs('alice'),
  );
  return {
    invitationId: invitation.data as string,
    groupId: group.data as string,
    groupReadModels: new InMemoryGroupReadModels(groupStore),
    handler: new AcceptInvitationCommandHandler(invitations, groups, () => later),
  };
};

describe('AcceptInvitation', () => {
  it('may not be asked by anyone who is not signed in', async () => {
    const { handler } = await setup();

    expect(handler.anyoneMayAsk(AcceptInvitationCommandEvent.set({ invitationId: 'any' }))).toBe(false);
  });

  it('makes the caller a member of the group, the newest, from the moment it accepts', async () => {
    const { groupId, groupReadModels, handler, invitationId } = await setup();

    const result = await handler.execute(AcceptInvitationCommandEvent.set({ invitationId }), signedInAs('bob'));

    expect(result.isSuccess()).toBe(true);
    expect(await groupReadModels.listMembers(groupId, 'bob')).toEqual([
      { memberId: 'alice', name: '', role: 'owner', joinedAt: at.toISOString() },
      { memberId: 'bob', name: '', role: 'member', joinedAt: later.toISOString() },
    ]);
  });

  it('refuses a second join of a member who is already in the group', async () => {
    const { handler, invitationId } = await setup();
    await handler.execute(AcceptInvitationCommandEvent.set({ invitationId }), signedInAs('bob'));

    const again = await handler.execute(AcceptInvitationCommandEvent.set({ invitationId }), signedInAs('bob'));
    const owner = await handler.execute(AcceptInvitationCommandEvent.set({ invitationId }), signedInAs('alice'));

    expect(again.isFailure() && again.error.type).toBe('AlreadyAMember');
    expect(owner.isFailure() && owner.error.type).toBe('AlreadyAMember');
  });

  it('refuses an invitation that is not there', async () => {
    const { handler } = await setup();

    const result = await handler.execute(AcceptInvitationCommandEvent.set({ invitationId: 'nope' }), signedInAs('bob'));

    expect(result.isFailure() && result.error.type).toBe('NotFound');
  });

  it('refuses a caller who is not signed in', async () => {
    const { handler, invitationId } = await setup();

    const result = await handler.execute(AcceptInvitationCommandEvent.set({ invitationId }), anonymous());

    expect(result.isFailure() && result.error.type).toBe('NotAllowed');
  });
});
