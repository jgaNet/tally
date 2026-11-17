import { Exception } from '@Architecture/Domain';

/** The name is not 1 to 60 characters, or is only spaces. */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'The name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** The currency is not one of the six a group may be in. */
export class UnsupportedCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'UnsupportedCurrency',
      message: 'The currency is one of EUR, USD, GBP, CHF, CAD or AUD',
    });
  }
}
