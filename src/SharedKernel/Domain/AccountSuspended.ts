import { Exception } from '@Architecture/Domain';

/**
 * The one rule every expense, recurring expense, cash settlement, provider payment and netting an account starts is refused by while it
 * is suspended (request 34, docs/adr/0034): the same name in every context. Groups decides the suspension and reinstatement; each context
 * asks Groups whether the caller is suspended, through the port it already owns, and its own aggregate refuses with this exception.
 * `service` names the context that refused.
 */
export class AccountSuspendedException extends Exception {
  constructor(service: string) {
    super({
      service,
      type: 'AccountSuspended',
      message: 'The account is suspended: it changes nothing until an administrator reinstates it',
    });
  }
}
