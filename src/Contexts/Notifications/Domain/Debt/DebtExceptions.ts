import { Exception } from '@Architecture/Domain';

/** The base of every refusal the DebtWatch aggregate makes. */
export abstract class DebtException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Notifications', type, message, context });
  }
}

export class DebtNotOverThreshold extends DebtException {
  constructor() {
    super('DebtNotOverThreshold', 'A debt is only watched while it is more than the threshold');
  }
}
