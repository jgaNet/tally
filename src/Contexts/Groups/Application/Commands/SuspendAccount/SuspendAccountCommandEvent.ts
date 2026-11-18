import { CommandEvent } from '@Architecture/Domain';

/** An administrator suspends an account: nothing it starts is done until it is reinstated (request 34). Changes nothing when it is suspended already. */
export class SuspendAccountCommandEvent extends CommandEvent<{ accountId: string }> {}
