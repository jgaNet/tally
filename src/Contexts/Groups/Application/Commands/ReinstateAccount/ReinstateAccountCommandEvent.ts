import { CommandEvent } from '@Architecture/Domain';

/** The payload of reinstating: the account the administrator reinstates, as the route names it (request 34). */
export interface ReinstateAccountPayload {
  accountId: string;
}

export class ReinstateAccountCommandEvent extends CommandEvent<ReinstateAccountPayload> {}
