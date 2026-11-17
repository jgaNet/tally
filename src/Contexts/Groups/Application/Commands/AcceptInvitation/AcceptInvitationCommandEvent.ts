import { CommandEvent } from '@Architecture/Domain';

/** The payload of joining: the invitation whose link the caller holds, as the route names it. */
export interface AcceptInvitationPayload {
  invitationId: string;
}

export class AcceptInvitationCommandEvent extends CommandEvent<AcceptInvitationPayload> {}
