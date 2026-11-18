import { NotAllowedException, NotFoundException } from '@Architecture/Domain';

/** The administrators' log is not there for the caller: `404` to anyone who is not an administrator (request 33). */
export class AdministratorLogNotFoundException extends NotFoundException {
  constructor() {
    super('Groups', "No administrators' log is there for you");
  }
}

/** Only an administrator suspends or reinstates an account (request 34): `403` to anyone else, who is signed in. */
export class NotAnAdministratorException extends NotAllowedException {
  constructor() {
    super('Groups', 'Only an administrator may suspend or reinstate an account');
  }
}
