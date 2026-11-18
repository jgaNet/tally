import { LedgerException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The file is not a JPEG or a PNG of 1 byte to 2 MB, by its first bytes and its length. */
export class InvalidReceiptFile extends LedgerException {
  constructor() {
    super('InvalidReceiptFile', 'A receipt is a JPEG or a PNG of 1 byte to 2 MB');
  }
}

/** The receipts store did not keep the file: it answered something else, did not answer in time, or is not configured. */
export class ReceiptNotStored extends LedgerException {
  constructor() {
    super('ReceiptNotStored', 'The receipts store did not keep the receipt');
  }
}
