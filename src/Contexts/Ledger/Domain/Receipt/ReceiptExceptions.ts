import { Exception } from '@Architecture/Domain';

/** The file is not a JPEG or a PNG of 1 to 2 097 152 bytes, judged by its first bytes. */
export class InvalidReceiptException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidReceipt',
      message: 'A receipt is a JPEG or a PNG of 1 to 2097152 bytes',
    });
  }
}

/** The receipts store did not keep the file: it answered something else, or not within 5 seconds, or is not configured. */
export class ReceiptNotKeptException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ReceiptNotKept',
      message: 'The receipts store did not keep the file, so the receipt is not attached',
    });
  }
}
