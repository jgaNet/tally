import { IResult, Result } from '@Architecture/Domain';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { ReceiptStoreUnavailable } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { StoredReceiptFile } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * The receipts store over HTTP (request 26, ADR 19): `POST {RECEIPTS_URL}/files` with the file as the body and its type as
 * `Content-Type`, answered `201 { id, url }`: the file's id there, and the link it is read at. Anything else, an answer after
 * 5 seconds, or no `RECEIPTS_URL` at all, is `ReceiptStoreUnavailable`, and the receipt is not attached.
 */
export class HttpReceiptStore implements IReceiptStore {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs: number = 5000,
  ) {}

  async keep(file: ReceiptFile): Promise<IResult<StoredReceiptFile>> {
    if (!this.baseUrl) return Result.fail(new ReceiptStoreUnavailable());
    try {
      const response = await fetch(`${this.baseUrl}/files`, {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: Buffer.from(file.bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new ReceiptStoreUnavailable());
      const body = (await response.json()) as { id?: unknown; url?: unknown };
      if (typeof body.id !== 'string' || !body.id || typeof body.url !== 'string' || !body.url) {
        return Result.fail(new ReceiptStoreUnavailable());
      }
      return Result.ok({ id: body.id, url: body.url });
    } catch {
      return Result.fail(new ReceiptStoreUnavailable());
    }
  }
}
