import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { Group, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';

/** The store of groups over a Map, in the order they were added: what the use cases' specs double the database with. */
export class InMemoryGroupStore implements IGroupStore {
  readonly groups = new Map<string, GroupSnapshot>();

  async add(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    this.groups.set(snapshot.id, snapshot);
  }

  async viewFor(groupId: string, memberId: string): Promise<GroupView | undefined> {
    const group = this.groups.get(groupId);
    return group && group.memberIds.includes(memberId) ? toView(group) : undefined;
  }

  async listFor(memberId: string): Promise<GroupView[]> {
    // A Map keeps insertion order: the last added comes first, as the store's order says.
    return [...this.groups.values()]
      .filter(group => group.memberIds.includes(memberId))
      .reverse()
      .map(toView);
  }
}

const toView = (group: GroupSnapshot): GroupView => ({
  id: group.id,
  name: group.name,
  currency: group.currency,
  ownerId: group.ownerId,
});
