import { CommandEvent } from '@Architecture/Domain';

export class SuspendAccountCommandEvent extends CommandEvent<{ accountId: string }> {}
