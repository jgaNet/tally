import { CommandEvent } from '@Architecture/Domain';

export class ArchiveGroupCommandEvent extends CommandEvent<{ groupId: string }> {}
