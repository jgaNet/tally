import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { StoredReceipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * Ledger's port to the receipts store, which it owns (request 26, ADR 17): where a receipt file is kept. The answer is the file's id there
 * and the link it is read at, a plain value the receipt takes; `null` when the store kept nothing (it answered otherwise, did not answer in
 * time, or is not configured). Answered by an adapter over the store's HTTP API.
 */
export interface IReceiptStore {
  keep(file: { bytes: Uint8Array; type: ReceiptType }): Promise<StoredReceipt | null>;
}
