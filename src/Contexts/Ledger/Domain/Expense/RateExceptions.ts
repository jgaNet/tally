import { Exception } from '@Architecture/Domain';

/**
 * An expense is refused by the name of this rule when it takes or gives a rate that no rates service offers for its currency and day
 * (request 22): when its rate is left out and none is offered, or when its rate is given and none is offered to compare it with.
 */
export class NoRateOfferedException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'NoRateOffered',
      message: 'No rate is offered for this currency on this day, so the expense cannot be counted at one',
    });
  }
}

/** The rate given differs from the one offered for its currency and day by more than 2 % of the offered one (request 22). */
export class RateOutsideBandException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'RateOutsideBand',
      message: 'The rate differs from the one offered for this currency and day by more than 2 %',
    });
  }
}

/** The day a rate is asked for is a day written YYYY-MM-DD, a real one (request 22). */
export class InvalidRateDateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidRateDate',
      message: 'The date must be a real day, written YYYY-MM-DD',
    });
  }
}
