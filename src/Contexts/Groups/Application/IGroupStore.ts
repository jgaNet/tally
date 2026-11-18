import { Group } from '@Contexts/Groups/Domain/Group/Group';

/** What a screen shows of one group: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
  /** When the group was archived (feature 27, request 27): present once it is, and only then. */
  readonly archivedAt?: string;
}

/**
 * The store of groups, the port the use cases write and read through. `add` keeps a new group; `findById` loads one as
 * its aggregate, members included; `save` stores a changed group at the version after the one it was loaded at, and
 * refuses it with a ConcurrencyConflictException when another write took the version first (ADR 8). `viewFor` and
 * `listFor` answer only the groups the given account is a member of: a group it is not a member of is not there for it,
 * so the store never hands it out to be filtered after the read (ADR 5). `listFor` answers the most recently created
 * first, and for two created in the same instant, the one added last first; the query never sorts.
 */
export interface IGroupStore {
  add(group: Group): Promise<void>;
  findById(groupId: string): Promise<Group | undefined>;
  save(group: Group): Promise<void>;
  /**
   * Closes the group merged into the group kept (feature 31, request 31), in the caller's transaction: the group kept is saved as the
   * aggregate decided it, and the group merged is gone for everyone from then on. Its balances that passed and its audit entries are the
   * group kept's, and it has no members, invitations that let anyone join included (`findById` no longer finds it).
   */
  merge(kept: Group, merged: Group, at: string): Promise<void>;
  viewFor(groupId: string, memberId: string): Promise<GroupView | undefined>;
  listFor(memberId: string): Promise<GroupView[]>;
}
