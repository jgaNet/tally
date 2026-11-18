import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Receipt aggregate and its file make. */
export abstract class ReceiptException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Ledger', type, message, context });
  }
}

export class InvalidReceiptSize extends ReceiptException {
  constructor() {
    super('InvalidReceiptSize', 'A receipt must be a file of 1 to 2097152 bytes');
  }
}

export class UnsupportedReceiptType extends ReceiptException {
  constructor() {
    super('UnsupportedReceiptType', 'A receipt must be a JPEG or a PNG image');
  }
}

export class NotAllowedToAttachReceipt extends ReceiptException {
  constructor() {
    super(
      'NotAllowedToAttachReceipt',
      'Only the payer of the expense or the owner of its group may attach a receipt to it',
    );
  }
}

export class ReceiptStoreUnavailable extends ReceiptException {
  constructor() {
    super('ReceiptStoreUnavailable', 'The receipts store did not keep the receipt');
  }
}
