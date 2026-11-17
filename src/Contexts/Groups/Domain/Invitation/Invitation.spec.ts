import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Events/InvitationEvents';

const AT = new Date('2026-05-01T10:00:00.000Z');

describe('Invitation', () => {
  const group = () => Group.register({ name: 'Lisbon', currency: 'EUR', ownerId: 'ada', at: AT }).data!;

  it('is made by a member of the group, with an id of its own, and records InvitationCreated', () => {
    const lisbon = group();

    const made = Invitation.issue({ group: lisbon, invitedBy: 'ada', at: AT });

    expect(made.isSuccess()).toBe(true);
    const invitation = made.data!;
    expect(invitation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(invitation.groupId).toBe(lisbon.id);
    expect(invitation.invitedBy).toBe('ada');
    expect(invitation.version).toBe(0);
    const [event] = invitation.pullDomainEvents();
    expect(event).toBeInstanceOf(InvitationCreatedEvent);
    expect(event.payload).toEqual({ invitationId: invitation.id, groupId: lisbon.id, invitedBy: 'ada' });
  });

  it('is refused to someone who is not a member, as if the group did not exist', () => {
    const made = Invitation.issue({ group: group(), invitedBy: 'bob', at: AT });

    expect(made.error?.type).toBe('NotFound');
    expect(made.error?.message).toBe('There is no such group');
  });

  it('gives each invitation its own id', () => {
    const lisbon = group();
    const first = Invitation.issue({ group: lisbon, invitedBy: 'ada', at: AT }).data!;
    const second = Invitation.issue({ group: lisbon, invitedBy: 'ada', at: AT }).data!;

    expect(first.id).not.toBe(second.id);
  });

  it('round-trips through its snapshot, recording nothing', () => {
    const invitation = Invitation.issue({ group: group(), invitedBy: 'ada', at: AT }).data!;
    const snapshot = { ...invitation.toSnapshot(), version: 1 };

    const loaded = Invitation.fromSnapshot(snapshot);

    expect(loaded.toSnapshot()).toEqual(snapshot);
    expect(loaded.pullDomainEvents()).toEqual([]);
  });
});
