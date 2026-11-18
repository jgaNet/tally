import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { changeableExpense, findExpenseOf } from './expenses';
import { inTransaction } from './database';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * How Tally reaches the receipts store: the base of its API (`RECEIPTS_URL`, without a trailing slash), and how long
 * it may take to answer a file (5 seconds, unless a test says otherwise). Without a URL, a receipt is refused.
 */
export interface ReceiptsConfig {
  url?: string;
  timeoutMs?: number;
}

/** The largest receipt, in bytes: 2 MB. */
export const RECEIPT_MAX_BYTES = 2_097_152;

export type ReceiptType = 'image/jpeg' | 'image/png';

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The type of a receipt, read from its first bytes: a JPEG or a PNG of 1 byte to `RECEIPT_MAX_BYTES`. Anything else is
 * `undefined`.
 */
export function receiptTypeOf(bytes: Buffer): ReceiptType | undefined {
  if (bytes.length < 1 || bytes.length > RECEIPT_MAX_BYTES) return undefined;
  if (bytes.subarray(0, JPEG_START.length).equals(JPEG_START)) return 'image/jpeg';
  if (bytes.subarray(0, PNG_START.length).equals(PNG_START)) return 'image/png';
  return undefined;
}

/**
 * A refusal for a request the receipts store could not answer: it did not answer `201` with an `id` and a `url`, or
 * did not answer in time.
 */
function storeUnavailable(): Refusal {
  return new Refusal(424, 'ReceiptsUnavailable', 'The receipts store did not keep the receipt.');
}

/**
 * Hands the file to the receipts store, as the body of `POST /files` with its type. Only `201` with an `id` and a `url`
 * is an answer: any other answer, or none within the time allowed, is refused.
 */
async function storeReceipt(
  config: ReceiptsConfig & { url: string },
  bytes: Buffer,
  type: ReceiptType,
): Promise<{ id: string; url: string }> {
  try {
    const response = await fetch(`${config.url}/files`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw storeUnavailable();
    }
    const answer = (await response.json()) as { id?: unknown; url?: unknown } | null;
    if (typeof answer?.id !== 'string' || answer.id === '' || typeof answer.url !== 'string' || answer.url === '') {
      throw storeUnavailable();
    }
    return { id: answer.id, url: answer.url };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw storeUnavailable();
  }
}

interface ReceiptRow {
  type: ReceiptType;
  size: number;
  url: string;
}

const receiptSchema = {
  type: 'object',
  required: ['type', 'size', 'url'],
  properties: {
    type: { type: 'string', enum: ['image/jpeg', 'image/png'] },
    size: { type: 'integer', minimum: 1, maximum: RECEIPT_MAX_BYTES },
    url: { type: 'string', minLength: 1 },
  },
};

/**
 * Attaching a receipt is an edit of the expense's receipt by whoever may edit the expense: its payer and the owner of
 * its group. The file is checked before anything is sent, then kept in the receipts store; only then is it attached, in
 * place of the receipt the expense had. A receipt is not an edit of the expense, so its version stays.
 */
export function registerReceiptRoutes(app: FastifyInstance, db: DatabaseSync, receipts: ReceiptsConfig): void {
  // The file is read as its bytes, as it was sent. A larger one is refused by the server before it is read.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: RECEIPT_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.put<{ Params: { id: string } }>('/expenses/:id/receipt', async (request, reply) => {
    const accountId = requireCaller(db, request);
    const expenseId = request.params.id;
    changeableExpense(db, accountId, expenseId);
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const type = receiptTypeOf(bytes);
    if (type === undefined) {
      throw new Refusal(
        422,
        'InvalidReceipt',
        'A receipt is a JPEG or a PNG of 1 byte to 2 MB, sent as application/octet-stream.',
      );
    }
    if (!receipts.url) {
      throw new Refusal(409, 'ReceiptsNotConfigured', 'Keeping receipts is not set up on this server.');
    }
    const stored = await storeReceipt({ ...receipts, url: receipts.url }, bytes, type);
    inTransaction(db, () => {
      // The expense may have changed while the store kept the file: the receipt goes only to an expense that may still take one.
      changeableExpense(db, accountId, expenseId);
      db.prepare(
        `INSERT INTO receipts (expense_id, type, size, store_id, url, attached_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (expense_id) DO UPDATE SET
           type = excluded.type, size = excluded.size, store_id = excluded.store_id,
           url = excluded.url, attached_at = excluded.attached_at`,
      ).run(expenseId, type, bytes.length, stored.id, stored.url, new Date().toISOString());
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/expenses/:id/receipt',
    { schema: { response: { 200: receiptSchema } } },
    request => {
      const accountId = requireCaller(db, request);
      if (!findExpenseOf(db, accountId, request.params.id)) {
        throw new Refusal(404, 'NotFound', 'There is no such expense.');
      }
      const row = db.prepare('SELECT type, size, url FROM receipts WHERE expense_id = ?').get(request.params.id) as
        ReceiptRow | undefined;
      if (!row) throw new Refusal(404, 'NotFound', 'The expense has no receipt.');
      return { type: row.type, size: row.size, url: row.url };
    },
  );
}
