import { Exception } from '@Architecture/Domain';

/**
 * The refusal of every new split, payment through the provider and netting that a deleted account would be in (request 35,
 * ADR 26): one rule's name, the same in every context. Groups decides that an account is deleted; every other context asks
 * Groups through a port it owns, and its aggregate refuses with this.
 */
export class AccountDeleted extends Exception {
  constructor() {
    super({
      service: 'SharedKernel',
      type: 'AccountDeleted',
      message: 'The account is deleted: it cannot be part of this',
    });
  }
}
