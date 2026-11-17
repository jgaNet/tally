import { Id, IResult, Result } from '@Architecture/Domain';

import { InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IInvitationQueries } from '@Contexts/Groups/Application/Ports/IInvitationQueries';
import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';
import { InMemoryGroupStore } from '@Contexts/Groups/Infrastructure/InMemoryGroups';

/** The invitations kept in memory, shared by the in-memory adapters of the ports, for the specs. */
export type InMemoryInvitationStore = Map<string, InvitationSnapshot>;

export class InMemoryInvitationRepository implements IInvitationRepository {
  constructor(private store: InMemoryInvitationStore = new Map()) {}

  async findById(id: Id): Promise<Invitation | null> {
    const snapshot = this.store.get(id.value);
    return snapshot ? Invitation.fromSnapshot(snapshot) : null;
  }

  async save(invitation: Invitation): Promise<IResult> {
    const snapshot = invitation.toSnapshot();
    this.store.set(snapshot.id, snapshot);
    return Result.ok();
  }
}

export class InMemoryInvitationReadModels implements IInvitationQueries {
  constructor(
    private store: InMemoryInvitationStore,
    private groups: InMemoryGroupStore,
  ) {}

  async findById(invitationId: string): Promise<InvitationReadModel | null> {
    const snapshot = this.store.get(invitationId);
    const group = snapshot && this.groups.get(snapshot.groupId);
    if (!snapshot || !group) return null;
    return { id: snapshot.id, groupId: snapshot.groupId, groupName: group.name, invitedBy: snapshot.invitedBy };
  }
}
