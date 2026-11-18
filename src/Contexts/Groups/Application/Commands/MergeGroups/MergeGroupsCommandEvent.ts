import { CommandEvent } from '@Architecture/Domain';

/** The owner merges the group `from` into the group `groupId`, which is kept (request 31). */
export class MergeGroupsCommandEvent extends CommandEvent<{ groupId: string; from: string }> {}
