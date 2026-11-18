import { NotFoundException } from '@Architecture/Domain';

/** The administrators' log is not there for the caller: `404` to anyone who is not an administrator (request 33). */
export class AdministratorLogNotFoundException extends NotFoundException {
  constructor() {
    super('Groups', "No administrators' log is there for you");
  }
}
