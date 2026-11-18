import { Exception, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Ledger';

/** A receipt's file that is empty, or larger than 2 MB: `422` (request 26), nothing is sent to the store. */
export class InvalidReceiptSizeException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidReceiptSize',
      message: 'A receipt is a file of 1 byte to 2 MB (2 097 152 bytes)',
    });
  }
}

/** A receipt's file that is neither a JPEG nor a PNG, read from its first bytes: `422` (request 26). */
export class UnsupportedReceiptTypeException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'UnsupportedReceiptType',
      message: 'A receipt is a JPEG or a PNG',
    });
  }
}

/** The store keeps no receipt: it is not configured, did not answer in time, or answered other than it should: `422` (request 26). */
export class ReceiptNotKeptException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'ReceiptNotKept',
      message: 'The receipt could not be kept in the receipts store, and nothing changed',
    });
  }
}

/** The expense has no receipt to read: `404` (request 26). */
export class ReceiptNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'The expense has no receipt');
  }
}
