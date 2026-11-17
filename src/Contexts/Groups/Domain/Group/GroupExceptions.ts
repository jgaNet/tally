import { Exception } from '@Architecture/Domain';

/** The name is 1 to 60 characters, and not only spaces (after trimming). */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'The name must have 1 to 60 characters, and not only spaces',
    });
  }
}

/** The currency is one of the six the group may be in: EUR, USD, GBP, CHF, CAD, AUD. */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'The currency must be one of EUR, USD, GBP, CHF, CAD, AUD',
    });
  }
}
