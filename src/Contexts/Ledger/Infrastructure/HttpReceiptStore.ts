import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { StoredReceipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** The receipts store's limit on an answer, in milliseconds: past it, the receipt is refused and nothing is kept. */
export const RECEIPTS_TIMEOUT_MS = 5000;

/**
 * The receipts store over its HTTP API: `POST {RECEIPTS_URL}/files`, the file as the body and its type as `Content-Type`, answered
 * `201 { id, url }`. Any other answer, an answer without a file id and a link, or no answer within the limit, keeps nothing (`null`).
 * `RECEIPTS_URL` is read when a file is kept, so a server started without it refuses every receipt and changes nothing else.
 */
export class HttpReceiptStore implements IReceiptStore {
  constructor(
    private baseUrl: () => string | undefined = () => process.env.RECEIPTS_URL,
    private timeoutMs = RECEIPTS_TIMEOUT_MS,
  ) {}

  async keep({ bytes, type }: { bytes: Uint8Array; type: ReceiptType }): Promise<StoredReceipt | null> {
    const base = this.baseUrl();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return null;
      const body = (await response.json()) as { id?: unknown; url?: unknown };
      return typeof body.id === 'string' && body.id !== '' && typeof body.url === 'string' && body.url !== ''
        ? { fileId: body.id, url: body.url }
        : null;
    } catch {
      return null;
    }
  }
}
