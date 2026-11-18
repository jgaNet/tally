import { CommandEvent } from '@Architecture/Domain';

/** An administrator reinstates a suspended account, so that what it starts is done again (request 34). Changes nothing when it is not suspended. */
export class ReinstateAccountCommandEvent extends CommandEvent<{ accountId: string }> {}
