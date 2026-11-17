import { CommandEvent } from '@Architecture/Domain';

export class CreateInvitationCommandEvent extends CommandEvent<{ groupId: string }> {}
