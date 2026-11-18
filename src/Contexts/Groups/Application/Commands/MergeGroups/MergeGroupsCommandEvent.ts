import { CommandEvent } from '@Architecture/Domain';

/** The group `groupId` is kept; the group `from` is merged into it (request 31). */
export class MergeGroupsCommandEvent extends CommandEvent<{ groupId: string; from: string }> {}
