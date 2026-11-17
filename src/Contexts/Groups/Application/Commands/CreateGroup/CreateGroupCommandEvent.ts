import { CommandEvent } from '@Architecture/Domain';

/** The payload of a group's creation: what the person typed. Its values are checked by the domain, not here. */
export interface CreateGroupPayload {
  name: string;
  currency: string;
}

export class CreateGroupCommandEvent extends CommandEvent<CreateGroupPayload> {}
