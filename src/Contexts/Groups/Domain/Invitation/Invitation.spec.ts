import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Events/InvitationEvents';

describe('Invitation', () => {
  it('is issued by a member of a group, with a long random id of its own, and records its creation', () => {
    const invitation = Invitation.issue({ groupId: 'group-1', invitedBy: 'ana' });

    expect(invitation.groupId).toBe('group-1');
    expect(invitation.invitedBy).toBe('ana');
    expect(invitation._id.value).toMatch(/^[0-9a-f-]{36}$/);

    const events = invitation.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(InvitationCreatedEvent);
    expect(events[0].payload).toEqual({
      invitationId: invitation._id.value,
      groupId: 'group-1',
      invitedBy: 'ana',
    });
  });

  it('gives each invitation an id of its own', () => {
    const first = Invitation.issue({ groupId: 'group-1', invitedBy: 'ana' });
    const second = Invitation.issue({ groupId: 'group-1', invitedBy: 'ana' });

    expect(first._id.value).not.toEqual(second._id.value);
  });

  it('rebuilds from a snapshot without recording anything, and refuses a corrupted one', () => {
    const snapshot = Invitation.issue({ groupId: 'group-1', invitedBy: 'ana' }).toSnapshot();
    const rebuilt = Invitation.fromSnapshot(snapshot);

    expect(rebuilt.pullDomainEvents()).toEqual([]);
    expect(rebuilt.toSnapshot()).toEqual(snapshot);
    expect(() => Invitation.fromSnapshot({ ...snapshot, groupId: '' })).toThrow();
  });
});
