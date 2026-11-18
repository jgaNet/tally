import { ConflictException } from '@Architecture/Domain';

/**
 * The one rule every context refuses a change by, once a group is archived (request 27): recording, editing or deleting an
 * expense, a settlement, an invitation, a join or a leave, a recurring expense, a budget, a template, and archiving it again.
 * Its name is the same in every context, so a client reads the same `type` whatever the change. Decided once, by Groups.
 */
export class GroupArchivedException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'GroupArchived',
      message: 'The group is archived: nothing in it changes any more',
    });
  }
}
