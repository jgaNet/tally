import { InvitationView, IInvitationStore } from '@Contexts/Groups/Application/IInvitationStore';
import { Invitation, InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InMemoryGroupStore } from '@Contexts/Groups/Infrastructure/InMemoryGroupStore';

/**
 * The store of invitations over a Map: what the use cases' specs double the database with. It reads a group's name from
 * the in-memory group store it is given, as the SQL view joins the groups table.
 */
export class InMemoryInvitationStore implements IInvitationStore {
  readonly invitations = new Map<string, InvitationSnapshot>();

  constructor(private readonly groups: InMemoryGroupStore) {}

  async add(invitation: Invitation): Promise<void> {
    const snapshot = invitation.toSnapshot();
    this.invitations.set(snapshot.id, snapshot);
  }

  async findById(invitationId: string): Promise<Invitation | undefined> {
    const snapshot = this.invitations.get(invitationId);
    return snapshot && Invitation.fromSnapshot(snapshot);
  }

  async viewOf(invitationId: string): Promise<InvitationView | undefined> {
    const invitation = this.invitations.get(invitationId);
    const group = invitation && this.groups.groups.get(invitation.groupId);
    return (
      invitation &&
      group && {
        id: invitation.id,
        groupId: invitation.groupId,
        groupName: group.name,
        invitedBy: invitation.invitedBy,
      }
    );
  }
}
