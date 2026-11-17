import { Invitation } from './Invitation';
import { InvitationCreatedEvent } from './InvitationEvents';

const at = new Date('2026-04-01T09:00:00.000Z');
const groupId = '6f1d2c3b-0000-4000-8000-0000000000aa';
const invitedBy = '3c9d2f1e-0000-4000-8000-000000000001';

describe('Invitation.issue', () => {
  it('generates its own id, long and random, and records its creation', () => {
    const invitation = Invitation.issue({ groupId, invitedBy, at });

    expect(invitation._id.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Invitation.issue({ groupId, invitedBy, at })._id.value).not.toBe(invitation._id.value);
    expect(invitation.pullDomainEvents()).toEqual([
      InvitationCreatedEvent.set({ invitationId: invitation._id.value, groupId, invitedBy, createdAt: at }),
    ]);
  });
});

describe('Invitation.fromSnapshot', () => {
  const stored = {
    id: '0d5c9a1e-0000-4000-8000-0000000000bb',
    groupId,
    invitedBy,
    createdAt: at.toISOString(),
  };

  it('rebuilds the invitation as it was stored, recording nothing', () => {
    const invitation = Invitation.fromSnapshot(stored);

    expect(invitation.toSnapshot()).toEqual(stored);
    expect(invitation.pullDomainEvents()).toEqual([]);
  });

  it('throws on data no issue() could have made', () => {
    expect(() => Invitation.fromSnapshot({ ...stored, invitedBy: '' })).toThrow(/corrupted/);
    expect(() => Invitation.fromSnapshot({ ...stored, createdAt: 'not a date' })).toThrow(/corrupted/);
  });
});
