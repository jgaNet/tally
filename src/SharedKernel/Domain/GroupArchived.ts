import { Exception } from '@Architecture/Domain';

/**
 * The one rule every context refuses a change in an archived group by (feature 27, request 27): the group is archived, so nothing in it
 * changes any more. The word is the shared kernel's, named once here and decided by Groups (the storm's T17): each context asks Groups,
 * through the port it owns (`isArchived`), whether the group is archived, and its aggregate refuses by this exception. A refusal by a
 * rule: `422` (ADR 4). The same name and the same answer for every request that would change something in an archived group.
 */
export const GROUP_ARCHIVED = 'GroupArchived';

export class GroupArchivedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: GROUP_ARCHIVED,
      message: 'The group is archived: nothing in it changes any more',
    });
  }
}
