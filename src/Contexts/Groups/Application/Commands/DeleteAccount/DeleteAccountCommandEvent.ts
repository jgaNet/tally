import { CommandEvent } from '@Architecture/Domain';

/** The signed-in person deletes their own account (request 35): it names no account, the caller is the one. */
export class DeleteAccountCommandEvent extends CommandEvent<Record<string, never>> {}
