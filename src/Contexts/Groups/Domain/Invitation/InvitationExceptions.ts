import { NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Groups';

/**
 * No invitation has this id: `404` (ADR 5). An invitation is read by anyone who holds its link, so there is no other
 * answer to a link that does not lead anywhere.
 */
export class InvitationNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No invitation is there with this id');
  }
}
