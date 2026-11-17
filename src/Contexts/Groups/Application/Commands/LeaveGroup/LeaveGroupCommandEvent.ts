import { CommandEvent } from '@Architecture/Domain';

export class LeaveGroupCommandEvent extends CommandEvent<{ groupId: string }> {}
