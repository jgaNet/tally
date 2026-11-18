import { Exception } from '@Architecture/Domain';

/**
 * The one refusal every context gives a new split, payment or netting that concerns an account its person deleted (request 35, ADR 26): the
 * name of the rule, the same in every context. Groups decides a deletion; each other context asks Groups through the port it owns which
 * accounts are deleted, and its aggregate refuses with this. A deleted account stays a member of its groups, with its balance: only what
 * would start something new with it is refused.
 */
export class AccountDeleted extends Exception {
  constructor(service: string) {
    super({ service, type: 'AccountDeleted', message: 'The account is deleted: nothing new is done with it' });
  }
}
