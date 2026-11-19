import { CommandEvent } from '@Architecture/Domain';

export class DeleteAccountCommandEvent extends CommandEvent<Record<string, never>> {}
