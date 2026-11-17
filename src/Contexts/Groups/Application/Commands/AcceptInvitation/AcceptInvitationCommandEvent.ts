import { CommandEvent } from '@Architecture/Domain';

export class AcceptInvitationCommandEvent extends CommandEvent<{ invitationId: string }> {}
