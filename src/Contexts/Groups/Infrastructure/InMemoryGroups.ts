import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';

/** The groups kept in memory, shared by the in-memory adapters of the ports, for the specs. */
export type InMemoryGroupStore = Map<string, GroupSnapshot>;

export class InMemoryGroupRepository implements IGroupRepository {
  constructor(private store: InMemoryGroupStore = new Map()) {}

  async findById(id: Id): Promise<Group | null> {
    const snapshot = this.store.get(id.value);
    return snapshot ? Group.fromSnapshot(snapshot) : null;
  }

  async save(group: Group): Promise<IResult> {
    const snapshot = group.toSnapshot();
    if (snapshot.version === 0) {
      this.store.set(snapshot.id, { ...snapshot, version: 1 });
      return Result.ok();
    }
    const kept = this.store.get(snapshot.id);
    if (!kept || kept.version !== snapshot.version) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The group has changed', { id: snapshot.id }));
    }
    this.store.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
    return Result.ok();
  }
}

export class InMemoryGroupReadModels implements IGroupQueries {
  /** `accounts` is where the members' names are read from, when the members are listed. */
  constructor(
    private store: InMemoryGroupStore,
    private accounts: Map<string, AccountSnapshot> = new Map(),
  ) {}

  async findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null> {
    const snapshot = this.store.get(groupId);
    return snapshot && isMember(snapshot, accountId) ? toReadModel(snapshot) : null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    return [...this.store.values()]
      .filter(snapshot => isMember(snapshot, accountId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toReadModel);
  }

  async listMembers(groupId: string, accountId: string): Promise<MemberReadModel[] | null> {
    const snapshot = this.store.get(groupId);
    if (!snapshot || !isMember(snapshot, accountId)) return null;
    return snapshot.members.map(member => ({
      memberId: member.accountId,
      name: this.accounts.get(member.accountId)?.name ?? '',
      role: member.accountId === snapshot.ownerId ? 'owner' : 'member',
      joinedAt: member.joinedAt,
    }));
  }
}

/** The balances a member has in a group, as the test gives them: keyed by the group's id and the member's, 0 when not given. */
export class InMemoryMemberBalances implements IMemberBalances {
  constructor(private balances: Map<string, number> = new Map()) {}

  set(groupId: string, accountId: string, balance: number): void {
    this.balances.set(`${groupId}/${accountId}`, balance);
  }

  async balanceOf(groupId: string, accountId: Id): Promise<number> {
    return this.balances.get(`${groupId}/${accountId.value}`) ?? 0;
  }
}

const isMember = (snapshot: GroupSnapshot, accountId: string): boolean =>
  snapshot.members.some(member => member.accountId === accountId);

const toReadModel = (snapshot: GroupSnapshot): GroupReadModel => ({
  id: snapshot.id,
  name: snapshot.name,
  currency: snapshot.currency,
  ownerId: snapshot.ownerId,
});
