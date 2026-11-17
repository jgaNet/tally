import { CommandEvent } from '@Architecture/Domain';

/** The payload of an invitation: the group it invites to, as the route names it. */
export interface CreateInvitationPayload {
  groupId: string;
}

export class CreateInvitationCommandEvent extends CommandEvent<CreateInvitationPayload> {}
