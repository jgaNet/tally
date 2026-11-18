import { Exception } from '@Architecture/Domain';

/**
 * The one refusal every context gives a change a suspended account starts (request 34, ADR 25): the name of the rule, the same in every
 * context, so a client gets one answer whichever change it asked for. Groups decides a suspension; each other context asks Groups through
 * the port it owns whether the account is suspended, and its aggregate refuses with this, before anything else it checks.
 */
export class AccountSuspended extends Exception {
  constructor(service: string) {
    super({ service, type: 'AccountSuspended', message: 'The account is suspended: nothing it starts is done' });
  }
}
