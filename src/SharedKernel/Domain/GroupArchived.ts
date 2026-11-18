import { Exception } from '@Architecture/Domain';

/**
 * The one refusal every context gives a change in an archived group (request 27, ADR 18): the name of the rule, the same in every
 * context, so a client gets one answer whichever change it asked for. Groups decides an archive; each other context asks Groups
 * through the port it owns whether the group is archived, and its aggregate refuses with this, before anything else it checks.
 */
export class GroupArchived extends Exception {
  constructor(service: string) {
    super({ service, type: 'GroupArchived', message: 'The group is archived: nothing in it changes' });
  }
}
