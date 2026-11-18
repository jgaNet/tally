import { IReceiptStore, StoredReceipt } from '@Contexts/Ledger/Application/IReceiptStore';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/** How long the receipts store has to answer, in milliseconds: past it, the receipt is refused (request 26). */
export const RECEIPTS_TIMEOUT_MS = 5000;

/**
 * The receipts store over its HTTP API (request 26): `POST {RECEIPTS_URL}/files`, the file as the body and its type as the `Content-Type`, answered
 * `201 { id, url }`: the file's id, and the link it is read at. Any other answer, a body that is not that, or no answer within the timeout, keeps
 * nothing. With no base URL (`RECEIPTS_URL` is not set) there is no store at all, and nothing is kept. It never throws.
 */
export class HttpReceiptStore implements IReceiptStore {
  constructor(private readonly baseUrl: string | undefined) {}

  async keep({ type, bytes }: { type: ReceiptType; bytes: Uint8Array }): Promise<StoredReceipt | undefined> {
    if (!this.baseUrl) return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/files`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(RECEIPTS_TIMEOUT_MS),
      });
      if (response.status !== 201) return undefined;
      const answer = (await response.json()) as { id?: unknown; url?: unknown } | null;
      return typeof answer?.id === 'string' && answer.id !== '' && typeof answer.url === 'string' && answer.url !== ''
        ? { id: answer.id, url: answer.url }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
