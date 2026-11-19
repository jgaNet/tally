import { CommandEvent } from '@Architecture/Domain';

export class ReinstateAccountCommandEvent extends CommandEvent<{ accountId: string }> {}
