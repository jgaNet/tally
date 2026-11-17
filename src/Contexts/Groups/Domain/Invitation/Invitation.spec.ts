import { describe, expect, it } from '@jest/globals';

import { Invitation, InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Invitation';

/** An invitation's creation, the link it is, and the round-trip through the store's snapshot (feature 3). */
const now = new Date('2026-05-01T10:00:00.000Z');

describe('Invitation.issue', () => {
  it('names its group and its inviter, and records InvitationCreated', () => {
    const invitation = Invitation.issue({ groupId: 'group-1', invitedBy: 'account-ann' }, now);

    expect(invitation.toSnapshot()).toEqual({
      id: expect.any(String),
      groupId: 'group-1',
      invitedBy: 'account-ann',
      createdAt: '2026-05-01T10:00:00.000Z',
    });
    const [recorded] = invitation.pullDomainEvents();
    expect(recorded).toBeInstanceOf(InvitationCreatedEvent);
    expect(recorded.payload).toEqual({
      invitationId: invitation.toSnapshot().id,
      groupId: 'group-1',
      invitedBy: 'account-ann',
      at: '2026-05-01T10:00:00.000Z',
    });
  });

  it('generates a long, random identity for each invitation: the link is not guessable', () => {
    const first = Invitation.issue({ groupId: 'group-1', invitedBy: 'account-ann' }, now).toSnapshot().id;
    const second = Invitation.issue({ groupId: 'group-1', invitedBy: 'account-ann' }, now).toSnapshot().id;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('Invitation.fromSnapshot', () => {
  it('rebuilds the invitation it was saved as, and records nothing', () => {
    const snapshot = {
      id: 'invitation-1',
      groupId: 'group-1',
      invitedBy: 'account-ann',
      createdAt: now.toISOString(),
    };
    const invitation = Invitation.fromSnapshot(snapshot);

    expect(invitation.toSnapshot()).toEqual(snapshot);
    expect(invitation.groupId).toBe('group-1');
    expect(invitation.pullDomainEvents()).toEqual([]);
  });

  it('throws on a snapshot with no group or no inviter', () => {
    expect(() =>
      Invitation.fromSnapshot({
        id: 'invitation-2',
        groupId: '',
        invitedBy: 'account-ann',
        createdAt: now.toISOString(),
      }),
    ).toThrow(/corrupted/);
  });
});
