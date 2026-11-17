import { CommandEvent } from '@Architecture/Domain';

/** The payload of leaving: the group the caller leaves, as the route names it. */
export interface LeaveGroupPayload {
  groupId: string;
}

export class LeaveGroupCommandEvent extends CommandEvent<LeaveGroupPayload> {}
