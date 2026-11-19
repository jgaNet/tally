import { Exception } from '@Architecture/Domain';

/**
 * The refusal of every expense, recurring expense, cash settlement, payment through the provider and netting that a suspended
 * account starts, in any group (request 34, ADR 25): one rule's name, the same in every context, so a client reads the same name
 * whichever context refuses it. Groups decides that an account is suspended; every other context asks Groups through a port it
 * owns, and its aggregate refuses with this.
 */
export class AccountSuspended extends Exception {
  constructor() {
    super({
      service: 'SharedKernel',
      type: 'AccountSuspended',
      message: 'The account is suspended: it cannot start this',
    });
  }
}
