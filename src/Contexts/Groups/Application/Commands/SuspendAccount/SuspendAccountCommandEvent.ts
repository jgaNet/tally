import { CommandEvent } from '@Architecture/Domain';

/** The payload of suspending: the account the administrator suspends, as the route names it (request 34). */
export interface SuspendAccountPayload {
  accountId: string;
}

export class SuspendAccountCommandEvent extends CommandEvent<SuspendAccountPayload> {}
