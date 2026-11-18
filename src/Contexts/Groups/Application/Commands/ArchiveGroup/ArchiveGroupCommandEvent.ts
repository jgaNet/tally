import { CommandEvent } from '@Architecture/Domain';

/** The payload of archiving: the group the caller archives, as the route names it. */
export interface ArchiveGroupPayload {
  groupId: string;
}

export class ArchiveGroupCommandEvent extends CommandEvent<ArchiveGroupPayload> {}
