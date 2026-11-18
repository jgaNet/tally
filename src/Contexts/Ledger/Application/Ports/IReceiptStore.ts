import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** The link the receipts store keeps a file at, as it answered (request 26). */
export interface KeptReceipt {
  url: string;
}

/**
 * Ledger's own port onto the receipts store, an outside system with an API of its own (request 26): where a receipt's file is
 * kept, answered as a plain value Ledger takes or refuses (DOMAIN-NON-DETERMINISM). Null when the store kept nothing: it answered
 * something else, did not answer within 5 seconds, or is not configured. The adapter answers over the store's HTTP API; nothing
 * here names it (ADR 17).
 */
export interface IReceiptStore {
  keep(file: ReceiptFile): Promise<KeptReceipt | null>;
}
