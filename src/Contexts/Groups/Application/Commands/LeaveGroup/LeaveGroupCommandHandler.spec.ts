import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Id } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { AcceptInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandEvent';
import { AcceptInvitationCommandHandler } from '@Contexts/Groups/Application/Commands/AcceptInvitation/AcceptInvitationCommandHandler';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';
import { CreateGroupCommandHandler } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandHandler';
import { CreateInvitationCommandEvent } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandEvent';
import { CreateInvitationCommandHandler } from '@Contexts/Groups/Application/Commands/CreateInvitation/CreateInvitationCommandHandler';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';
import { LeaveGroupCommandHandler } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandHandler';
import {
  InMemoryGroupRepository,
  InMemoryGroupStore,
  InMemoryGroupReadModels,
  InMemoryMemberBalances,
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

/** A group owned by alice, with bob in it: the stores the commands share, and Ledger's balances as the test gives them. */
const setup = async () => {
  const groupStore: InMemoryGroupStore = new Map();
  const invitationStore: InMemoryInvitationStore = new Map();
  const groups = new InMemoryGroupRepository(groupStore);
  const invitations = new InMemoryInvitationRepository(invitationStore);
  const balances = new InMemoryMemberBalances();
  const group = await new CreateGroupCommandHandler(groups, () => at).execute(
    CreateGroupCommandEvent.set({ name: 'Lisbon', currency: 'EUR' }),
    signedInAs('alice'),
  );
  const groupId = group.data as string;
  const invitation = await new CreateInvitationCommandHandler(groups, invitations, () => at).execute(
    CreateInvitationCommandEvent.set({ groupId }),
    signedInAs('alice'),
  );
  await new AcceptInvitationCommandHandler(invitations, groups, () => at).execute(
    AcceptInvitationCommandEvent.set({ invitationId: invitation.data as string }),
    signedInAs('bob'),
  );
  return {
    groupId,
    balances,
    groupReadModels: new InMemoryGroupReadModels(groupStore),
    handler: new LeaveGroupCommandHandler(groups, balances, () => later),
  };
};

describe('LeaveGroup', () => {
  it('may not be asked by anyone who is not signed in', async () => {
    const { handler } = await setup();

    expect(handler.anyoneMayAsk(LeaveGroupCommandEvent.set({ groupId: 'any' }))).toBe(false);
    const refused = await handler.execute(LeaveGroupCommandEvent.set({ groupId: 'any' }), anonymous());
    expect(refused.isFailure()).toBe(true);
  });

  it('takes a member out of the group once their balance in it is 0, and says so', async () => {
    const { groupId, groupReadModels, handler } = await setup();

    const result = await handler.execute(LeaveGroupCommandEvent.set({ groupId }), signedInAs('bob'));

    expect(result.isSuccess()).toBe(true);
    expect(await groupReadModels.findForMember(groupId, 'bob')).toBeNull();
    expect((await groupReadModels.listMembers(groupId, 'alice'))?.map(member => member.memberId)).toEqual(['alice']);
  });

  it('refuses a member whose balance in the group is not 0, and keeps them in it', async () => {
    const { groupId, balances, groupReadModels, handler } = await setup();
    balances.set(groupId, 'bob', -300);

    const result = await handler.execute(LeaveGroupCommandEvent.set({ groupId }), signedInAs('bob'));

    expect(result).toMatchObject({ error: { type: 'BalanceNotZero' } });
    expect(await groupReadModels.findForMember(groupId, 'bob')).not.toBeNull();
  });

  it('refuses the owner, whatever their balance', async () => {
    const { groupId, handler } = await setup();

    const result = await handler.execute(LeaveGroupCommandEvent.set({ groupId }), signedInAs('alice'));

    expect(result).toMatchObject({ error: { type: 'OwnerCannotLeave' } });
  });

  it('answers a group that is not there, or that the caller is not in, as a group that does not exist', async () => {
    const { groupId, handler } = await setup();

    const stranger = await handler.execute(LeaveGroupCommandEvent.set({ groupId }), signedInAs('carol'));
    const missing = await handler.execute(
      LeaveGroupCommandEvent.set({ groupId: new Id('nope').value }),
      signedInAs('bob'),
    );

    expect(stranger).toMatchObject({ error: { type: 'NotFound' } });
    expect(missing).toMatchObject({ error: { type: 'NotFound' } });
  });
});
