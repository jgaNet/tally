import { Exception } from '@Architecture/Domain';

/** A receipt is a JPEG or a PNG of 1 byte to 2 MB (request 26); any other file is refused by it. */
export class InvalidReceiptException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidReceipt',
      message: 'The receipt must be a JPEG or a PNG of at most 2 MB',
    });
  }
}

/** The receipts store did not keep the file (it answered otherwise, or not in 5 seconds, or is not configured): nothing changed. */
export class ReceiptNotKeptException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ReceiptNotKept',
      message: 'The receipt could not be kept, and nothing changed',
    });
  }
}
