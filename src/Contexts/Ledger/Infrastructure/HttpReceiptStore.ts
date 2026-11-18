import { IResult, Result } from '@Architecture/Domain';

import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { ReceiptStoreUnavailableException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** How long the receipts store may take to keep a file before the receipt is refused (request 26): 5 seconds. */
export const RECEIPTS_TIMEOUT_MS = 5000;

/**
 * The receipts store over its HTTP API (request 26, docs/adr/0025): `POST {RECEIPTS_URL}/files` with the file as the body, its type as the
 * `Content-Type`, answered `201 { id, url }`, the link the file is read at. Any other answer, a body that is not that, a failure to reach it,
 * or no answer within 5 seconds, is the refusal ReceiptStoreUnavailable, and nothing is kept. The base is read at each request, from the
 * environment, as the other outside systems' are: with no `RECEIPTS_URL` every receipt is refused.
 */
export class HttpReceiptStore implements IReceiptStore {
  constructor(
    private readonly baseUrl: () => string | undefined = () => process.env.RECEIPTS_URL,
    private readonly timeoutMs: number = RECEIPTS_TIMEOUT_MS,
  ) {}

  async keep({ bytes, type }: { bytes: Uint8Array; type: string }): Promise<IResult<string>> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return Result.fail(new ReceiptStoreUnavailableException());
    try {
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new ReceiptStoreUnavailableException());
      const link = linkOf(parseJson(await response.text()));
      return link === undefined ? Result.fail(new ReceiptStoreUnavailableException()) : Result.ok(link);
    } catch {
      return Result.fail(new ReceiptStoreUnavailableException());
    }
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The link of a `201 { id, url }`: both the file's id and its link are non-empty strings, or there is no link. */
const linkOf = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { id, url } = body as { id?: unknown; url?: unknown };
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
};
