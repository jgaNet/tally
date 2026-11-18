import { CommandEvent } from '@Architecture/Domain';

/** Deleting an account has no payload: the account is the caller's own, which the transport names (request 35). */
export type DeleteAccountPayload = Record<string, never>;

export class DeleteAccountCommandEvent extends CommandEvent<DeleteAccountPayload> {}
