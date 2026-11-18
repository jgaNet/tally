import { IResult } from '@Architecture/Domain';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { StoredReceiptFile } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * Where a receipt's file is kept, as Ledger decides it (request 26, ADR 19): an outside store that keeps the file and answers
 * the link it is read at. A file the store does not keep is a refusal, and the receipt is not attached.
 */
export interface IReceiptStore {
  keep(file: ReceiptFile): Promise<IResult<StoredReceiptFile>>;
}
