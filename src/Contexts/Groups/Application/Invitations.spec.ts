import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { InMemoryAccountStore } from '@Contexts/Groups/Infrastructure/InMemoryAccountStore';
import { InMemoryGroupStore } from '@Contexts/Groups/Infrastructure/InMemoryGroupStore';
import { InMemoryInvitationStore } from '@Contexts/Groups/Infrastructure/InMemoryInvitationStore';
import { createGroup, getGroupMembers } from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { Group } from '@Contexts/Groups/Domain/Group/Group';

/** Invitations and joining over the in-memory stores: who may invite, who may read the link, and who joins once. */
const now = new Date('2026-05-01T10:00:00.000Z');
const later = new Date('2026-05-02T09:00:00.000Z');
let current = now;
const clock = () => current;

let groups: InMemoryGroupStore;
let invitations: InMemoryInvitationStore;
let accounts: InMemoryAccountStore;
let context: (auth?: { subjectId?: string; role?: string }) => ExecutionContext;
let ann: ExecutionContext;
let bob: ExecutionContext;
let carol: ExecutionContext;

beforeEach(() => {
  current = now;
  groups = new InMemoryGroupStore();
  invitations = new InMemoryInvitationStore(groups);
  accounts = new InMemoryAccountStore();
  const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as unknown as EventBus;
  context = (auth = {}) => new ExecutionContext({ traceId: 'trace', eventBus, auth });
  ann = context({ subjectId: 'account-ann', role: 'USER' });
  bob = context({ subjectId: 'account-bob', role: 'USER' });
  carol = context({ subjectId: 'account-carol', role: 'USER' });
});

/** A group Ann created, and her invitation to it. */
async function annsGroupWithInvitation() {
  const { data: groupId } = await createGroup(groups, clock).run({ name: 'Flat', currency: 'EUR' }, ann);
  const { data: invitationId } = await createInvitation(groups, invitations, clock).run(groupId!, ann);
  return { groupId: groupId!, invitationId: invitationId! };
}

describe('createInvitation', () => {
  it('lets a member invite, and answers the id the link carries', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();

    expect(invitationId).toEqual(expect.any(String));
    expect(invitations.invitations.get(invitationId)).toMatchObject({
      id: invitationId,
      groupId,
      invitedBy: 'account-ann',
    });
  });

  it('answers a group that is not there for the caller with NotFound, and keeps nothing', async () => {
    const { groupId } = await annsGroupWithInvitation();

    const stranger = await createInvitation(groups, invitations, clock).run(groupId, bob);
    expect(stranger.isFailure() && stranger.error.type).toBe('NotFound');
    expect(invitations.invitations.size).toBe(1);
  });

  it('gives each invitation an id of its own, so every link is different', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();
    const second = await createInvitation(groups, invitations, clock).run(groupId, ann);
    expect(second.data).not.toBe(invitationId);
  });
});

describe('getInvitation', () => {
  it('answers the group and who invited, to a signed-in person who is not a member', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();

    const result = await getInvitation(invitations).run(invitationId, bob);
    expect(result.data).toEqual({
      id: invitationId,
      groupId,
      groupName: 'Flat',
      invitedBy: 'account-ann',
    });
  });

  it('answers an invitation that is not there with NotFound', async () => {
    const result = await getInvitation(invitations).run('no-such-invitation', bob);
    expect(result.isFailure() && result.error.type).toBe('NotFound');
  });
});

describe('acceptInvitation', () => {
  it('makes the caller a member, the last to join, and keeps the invitation usable', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();

    current = later;
    expect((await acceptInvitation(groups, invitations, clock).run(invitationId, bob)).isSuccess()).toBe(true);
    expect((await acceptInvitation(groups, invitations, clock).run(invitationId, carol)).isSuccess()).toBe(true);

    const group = (await groups.findById(groupId)) as Group;
    expect(group.members().map(member => member.accountId)).toEqual(['account-ann', 'account-bob', 'account-carol']);
    expect(group.members()[1].joinedAt).toBe(later.toISOString());
    expect(invitations.invitations.has(invitationId)).toBe(true);
  });

  it('refuses a member who joins again with AlreadyMember, and changes nothing', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();
    await acceptInvitation(groups, invitations, clock).run(invitationId, bob);

    const again = await acceptInvitation(groups, invitations, clock).run(invitationId, bob);
    expect(again.isFailure() && again.error.type).toBe('AlreadyMember');
    expect(((await groups.findById(groupId)) as Group).members()).toHaveLength(2);
  });

  it('refuses an invitation that is not there with NotFound', async () => {
    const result = await acceptInvitation(groups, invitations, clock).run('no-such-invitation', bob);
    expect(result.isFailure() && result.error.type).toBe('NotFound');
  });

  it('refuses a save over a group another writer changed since it was read, with a conflict', async () => {
    const { groupId, invitationId } = await annsGroupWithInvitation();
    const read = (await groups.findById(groupId)) as Group;
    await acceptInvitation(groups, invitations, clock).run(invitationId, bob);

    // Carol's writer read the group before Bob's join was saved: its save is refused.
    expect(read.join('account-carol', later).isSuccess()).toBe(true);
    await expect(groups.save(read)).rejects.toMatchObject({ type: 'ConcurrencyConflict' });
  });
});

describe('getGroupMembers', () => {
  it('lists the members in the order they joined, the owner first, with their names and roles', async () => {
    accounts.accounts.set('account-ann', {
      id: 'account-ann',
      email: 'ann@example.com',
      name: 'Ann',
      passwordHash: 'x',
      version: 0,
    });
    accounts.accounts.set('account-bob', {
      id: 'account-bob',
      email: 'bob@example.com',
      name: 'Bob',
      passwordHash: 'x',
      version: 0,
    });
    const { invitationId } = await annsGroupWithInvitation();
    current = later;
    await acceptInvitation(groups, invitations, clock).run(invitationId, bob);
    const groupId = [...groups.groups.keys()][0];

    const result = await getGroupMembers(groups, accounts).run(groupId, ann);
    expect(result.data).toEqual([
      { memberId: 'account-ann', name: 'Ann', role: 'owner', joinedAt: now.toISOString() },
      { memberId: 'account-bob', name: 'Bob', role: 'member', joinedAt: later.toISOString() },
    ]);
  });

  it('answers a group that is not there for the caller with NotFound', async () => {
    const { groupId } = await annsGroupWithInvitation();
    const result = await getGroupMembers(groups, accounts).run(groupId, carol);
    expect(result.isFailure() && result.error.type).toBe('NotFound');
  });
});
