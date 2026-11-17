import { NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Settlements';

/** The group is not there for the caller: the same `404` for a group that does not exist and one the caller is not in (request 11). */
export class GroupNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No group is there for you with this id');
  }
}
