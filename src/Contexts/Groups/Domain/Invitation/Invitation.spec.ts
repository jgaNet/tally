import { Id } from '@Architecture/Domain';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

const at = new Date('2026-01-02T03:04:05.000Z');

describe('Invitation', () => {
  it('is made with a generated id, its group and its creator, and records InvitationCreated', () => {
    const invitation = Invitation.issue({ groupId: new Id('group-1'), invitedBy: new Id('alice'), at });
    expect(invitation._id.value).toMatch(/^[0-9a-f-]{36}$/);
    const events = invitation.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['InvitationCreatedEvent']);
    expect(events[0].payload).toEqual({
      invitationId: invitation._id.value,
      groupId: 'group-1',
      invitedBy: 'alice',
      createdAt: at.toISOString(),
    });
  });

  it('gives each invitation its own id', () => {
    const one = Invitation.issue({ groupId: new Id('group-1'), invitedBy: new Id('alice'), at });
    const two = Invitation.issue({ groupId: new Id('group-1'), invitedBy: new Id('alice'), at });
    expect(one._id.value).not.toBe(two._id.value);
  });

  it('is reconstituted from its snapshot without recording anything, and refuses corrupted data', () => {
    const snapshot = Invitation.issue({ groupId: new Id('group-1'), invitedBy: new Id('alice'), at }).toSnapshot();
    const again = Invitation.fromSnapshot({ ...snapshot, version: 1 });
    expect(again.toSnapshot()).toEqual({ ...snapshot, version: 1 });
    expect(again.pullDomainEvents()).toEqual([]);
    expect(() => Invitation.fromSnapshot({ ...snapshot, groupId: '' })).toThrow('Corrupted invitation');
  });
});
