import { Group } from '@Contexts/Groups/Domain/Group/Group';

/** What a screen shows of one group: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
}

/**
 * The store of groups, the port the use cases write and read through. `viewFor` and `listFor` answer only the groups the
 * given account is a member of: a group it is not a member of is not there for it, so the store never hands it out to be
 * filtered after the read (ADR 5). `listFor` answers the most recently created first, and for two created in the same
 * instant, the one added last first; the query never sorts.
 */
export interface IGroupStore {
  add(group: Group): Promise<void>;
  viewFor(groupId: string, memberId: string): Promise<GroupView | undefined>;
  listFor(memberId: string): Promise<GroupView[]>;
}
