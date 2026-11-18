import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/** What the receipts store answers for a file it keeps: the file's id in the store, and the link it is read at (request 26). */
export interface StoredReceipt {
  readonly id: string;
  readonly url: string;
}

/**
 * The receipts store (request 26, the storm's ReceiptStore): the outside place a receipt's file is kept, in Ledger's own words, a port Ledger
 * owns, read when a receipt is attached. `keep` answers the file's id and link, or `undefined` when the store keeps nothing (it is not
 * configured, did not answer in time, or answered other than it should): the receipt is then refused, and nothing changes. The answer is a plain
 * value the receipt takes (DOMAIN-NON-DETERMINISM). The adapter over the store is Ledger's infrastructure, so no domain imports it.
 */
export interface IReceiptStore {
  keep(file: { type: ReceiptType; bytes: Uint8Array }): Promise<StoredReceipt | undefined>;
}
