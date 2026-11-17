import { Exception } from '@Architecture/Domain';

/** The name is empty, only spaces, or longer than 60 characters. */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'A group has a name of 1 to 60 characters, that is not only spaces',
    });
  }
}

/** The currency is not one of the six a group may be in. */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD or AUD',
    });
  }
}
