import { CommandEvent } from '@Architecture/Domain';

export class CreateGroupCommandEvent extends CommandEvent<{ name: string; currency: string }> {}
