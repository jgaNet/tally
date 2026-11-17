import { Group } from '@Contexts/Groups/Domain/Group/Group';

/** The groups, as aggregates: inserted as a whole, with the membership of their owner, the first member. */
export interface IGroupRepository {
  insert(group: Group): Promise<void>;
}
