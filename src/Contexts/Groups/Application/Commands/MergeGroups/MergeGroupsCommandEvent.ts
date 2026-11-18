import { CommandEvent } from '@Architecture/Domain';

/** The payload of a merge: the group kept, as the route names it, and the group merged, `from`, which the body names (request 31). */
export interface MergeGroupsPayload {
  groupId: string;
  from: string;
}

export class MergeGroupsCommandEvent extends CommandEvent<MergeGroupsPayload> {}
