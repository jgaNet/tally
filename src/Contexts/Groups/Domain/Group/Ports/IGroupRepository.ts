import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

export interface IGroupRepository {
  /** Stores a new group with its members, under the id it was born with. It runs in the command's transaction. */
  save(group: Group): Promise<IResult>;
}
