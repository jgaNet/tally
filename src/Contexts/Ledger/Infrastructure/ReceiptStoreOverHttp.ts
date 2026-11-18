import { IReceiptStore } from '@Contexts/Ledger/Application/IReceiptStore';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** How long the receipts store has to keep a file before the receipt is refused (request 26). */
export const RECEIPTS_TIMEOUT_MS = 5000;

/**
 * Answers Ledger's `IReceiptStore` port over the receipts store's API (request 26): `POST {RECEIPTS_URL}/files`, the file as the body with its
 * type as `Content-Type`, whose `201 { id, url }` is the link the file is read at. Any other answer, an answer without an id or a link, a timeout,
 * or a network failure keeps nothing (`undefined`). A server with no `RECEIPTS_URL` keeps nothing at all. The URL is read when a request comes, not
 * when the modules are built (ADR 7), and is the base of the API without a trailing slash.
 */
export class ReceiptStoreOverHttp implements IReceiptStore {
  constructor(
    private readonly baseUrl: () => string | undefined,
    private readonly timeoutMs: number = RECEIPTS_TIMEOUT_MS,
  ) {}

  async keep({ type, bytes }: { type: ReceiptType; bytes: Uint8Array }): Promise<string | undefined> {
    const base = this.baseUrl();
    if (!base) return undefined;
    try {
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return undefined;
      const body = (await response.json()) as { id?: unknown; url?: unknown };
      const kept = typeof body.id === 'string' && body.id.length > 0;
      return kept && typeof body.url === 'string' && body.url.length > 0 ? body.url : undefined;
    } catch {
      return undefined;
    }
  }
}
