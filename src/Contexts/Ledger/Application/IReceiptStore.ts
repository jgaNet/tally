import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/**
 * The receipts store, an outside service Tally keeps no files in (request 26): a port Ledger owns, in its own words, answered by an adapter over
 * the store at `RECEIPTS_URL` (`ReceiptStoreOverHttp`, in the wiring of this context). It keeps a file, whose type and bytes are given, and answers
 * the link it is read at, or `undefined` when the store did not keep it (no store, another answer, or no answer in 5 seconds): a plain value the
 * receipt takes (DOMAIN-NON-DETERMINISM, ADR 23). It is asked after the decision has allowed the file, never inside it.
 */
export interface IReceiptStore {
  keep(file: { type: ReceiptType; bytes: Uint8Array }): Promise<string | undefined>;
}
