import { Exception } from '@Architecture/Domain';

/** The file is neither a JPEG nor a PNG, by its first bytes (request 26): a refusal of the rule, `422`. */
export class ReceiptNotJpegOrPngException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ReceiptNotJpegOrPng',
      message: 'A receipt is a JPEG or a PNG',
    });
  }
}

/** The file is empty, or larger than 2 MB (request 26): a refusal of the rule, `422`. */
export class ReceiptSizeException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ReceiptSizeOutOfRange',
      message: 'A receipt is 1 byte to 2 MB (2 097 152 bytes)',
    });
  }
}

/** The receipts store kept no file: it answered anything else, or did not answer within 5 seconds (request 26). Nothing changes. */
export class ReceiptStoreUnavailableException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ReceiptStoreUnavailable',
      message: 'The receipts store kept no receipt for this expense',
    });
  }
}
