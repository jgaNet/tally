import { IReceiptStore, KeptReceipt } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** How long the receipts store has to answer before the receipt is refused (request 26). */
export const RECEIPTS_ANSWER_DEADLINE_MS = 5000;

/**
 * Ledger's adapter onto the receipts store over its HTTP API: `POST {RECEIPTS_URL}/files`, the file as the body and its type as
 * `Content-Type`, answered `201 { id, url }` (request 26). Any other answer, a link that is not a non-empty string, or no answer
 * within 5 seconds keeps nothing. Without a base URL nothing is sent and the store is taken to keep nothing. The base URL is read
 * when a file is kept, so the wiring can be configured at start.
 */
export class HttpReceiptStore implements IReceiptStore {
  constructor(private baseUrl: () => string | undefined) {}

  async keep(file: ReceiptFile): Promise<KeptReceipt | null> {
    const base = this.baseUrl();
    if (!base) return null;

    try {
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: new Uint8Array(file.bytes),
        signal: AbortSignal.timeout(RECEIPTS_ANSWER_DEADLINE_MS),
      });
      if (response.status !== 201) return null;

      const body = (await response.json()) as { url?: unknown };
      return typeof body.url === 'string' && body.url.length > 0 ? { url: body.url } : null;
    } catch {
      return null;
    }
  }
}
