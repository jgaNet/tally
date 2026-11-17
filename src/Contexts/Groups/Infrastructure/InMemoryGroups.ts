import { IResult, Result } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';

/** The groups kept in memory, shared by the in-memory adapters of the two ports, for the specs. */
export type InMemoryGroupStore = Map<string, GroupSnapshot>;

export class InMemoryGroupRepository implements IGroupRepository {
  constructor(private store: InMemoryGroupStore = new Map()) {}

  async save(group: Group): Promise<IResult> {
    const snapshot = group.toSnapshot();
    this.store.set(snapshot.id, snapshot);
    return Result.ok();
  }
}

export class InMemoryGroupReadModels implements IGroupQueries {
  constructor(private store: InMemoryGroupStore) {}

  async findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null> {
    const snapshot = this.store.get(groupId);
    return snapshot && snapshot.memberIds.includes(accountId) ? toReadModel(snapshot) : null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    return [...this.store.values()]
      .filter(snapshot => snapshot.memberIds.includes(accountId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toReadModel);
  }
}

const toReadModel = (snapshot: GroupSnapshot): GroupReadModel => ({
  id: snapshot.id,
  name: snapshot.name,
  currency: snapshot.currency,
  ownerId: snapshot.ownerId,
});
