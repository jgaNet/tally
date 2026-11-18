import { Exception } from '@Architecture/Domain';

/**
 * The group is archived (request 27): nothing in it changes any more. It is the one rule every context refuses a change by, under the
 * same name, so that a client switches on one word whatever the change was. Groups decides an archive and keeps the flag; each other
 * context asks Groups whether the group is archived, through the port it owns, and refuses with this exception. The name is a word of
 * the shared kernel, decided once (ADR 24).
 */
export class GroupArchivedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'GroupArchived',
      message: 'The group is archived: nothing in it changes any more',
    });
  }
}
