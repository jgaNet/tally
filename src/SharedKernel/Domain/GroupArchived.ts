import { Exception } from '@Architecture/Domain';

/**
 * The one rule every change in an archived group is refused by (request 27, docs/adr/0026): the same name in every context. Groups decides
 * the archiving; each context asks Groups whether a group is archived, through the port it already owns, and its own aggregate refuses with
 * this exception. `service` names the context that refused.
 */
export class GroupArchivedException extends Exception {
  constructor(service: string) {
    super({ service, type: 'GroupArchived', message: 'The group is archived: nothing in it changes any more' });
  }
}
