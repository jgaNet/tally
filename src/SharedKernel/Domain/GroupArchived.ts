import { Exception } from '@Architecture/Domain';

/**
 * The refusal of every change in an archived group (request 27, ADR 20): one rule's name, the same in every context, so a
 * client that asks for a change in an archived group reads the same name whichever context refuses it. Groups decides that
 * a group is archived; every other context asks Groups through a port it owns, and its aggregate refuses with this.
 */
export class GroupArchived extends Exception {
  constructor() {
    super({
      service: 'SharedKernel',
      type: 'GroupArchived',
      message: 'The group is archived: nothing in it changes any more',
    });
  }
}
