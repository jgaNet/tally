import { Exception } from '@Architecture/Domain';

/**
 * The one rule a deleted account is refused by in the contexts that start a change with it (request 35, docs/adr/0035): the same name in
 * every context. A deleted account is in no new split, is not paid through the provider and is not netted with. Groups decides the
 * deletion; each context asks Groups whether the account is deleted, through the port it already owns, and its own aggregate refuses with
 * this exception. `service` names the context that refused.
 */
export class AccountDeletedException extends Exception {
  constructor(service: string) {
    super({
      service,
      type: 'AccountDeleted',
      message: 'The account is deleted: it is in no new split, and it is paid and netted with through no provider',
    });
  }
}
