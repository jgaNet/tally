import { ConcurrencyConflictException } from '@Architecture/Domain';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { Group, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';

/** The store of groups over a Map, in the order they were added: what the use cases' specs double the database with. */
export class InMemoryGroupStore implements IGroupStore {
  readonly groups = new Map<string, GroupSnapshot>();

  async add(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    this.groups.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
  }

  async findById(groupId: string): Promise<Group | undefined> {
    const snapshot = this.groups.get(groupId);
    return snapshot && Group.fromSnapshot(snapshot);
  }

  async save(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    const stored = this.groups.get(snapshot.id);
    if (stored && stored.version !== snapshot.version) {
      throw new ConcurrencyConflictException('Groups', 'The group changed since it was read: read it again');
    }
    this.groups.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
  }

  async viewFor(groupId: string, memberId: string): Promise<GroupView | undefined> {
    const group = this.groups.get(groupId);
    return group && isMember(group, memberId) ? toView(group) : undefined;
  }

  async listFor(memberId: string): Promise<GroupView[]> {
    // A Map keeps insertion order: the last added comes first, as the store's order says.
    return [...this.groups.values()]
      .filter(group => isMember(group, memberId))
      .reverse()
      .map(toView);
  }
}

const isMember = (group: GroupSnapshot, memberId: string): boolean =>
  group.members.some(member => member.accountId === memberId);

const toView = (group: GroupSnapshot): GroupView => ({
  id: group.id,
  name: group.name,
  currency: group.currency,
  ownerId: group.ownerId,
  ...(group.archivedAt === undefined ? {} : { archivedAt: group.archivedAt }),
});
