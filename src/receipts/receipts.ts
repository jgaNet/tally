import { type Database, inTransaction } from '../database';
import { requireEditor, requireExpense } from '../expenses/expenses';
import { Refusal } from '../refusal';

/** Where the receipts store is, and how long it may take. */
export interface ReceiptsConfig {
  /** The base of the receipts store's API, without a trailing slash. Empty when there is no store. */
  url: string;
  /** How long the store may take to answer, in milliseconds. */
  timeoutMs: number;
}

export type ReceiptType = 'image/jpeg' | 'image/png';

/** A receipt is at least 1 byte and at most 2 MB (2 097 152 bytes). */
export const RECEIPT_MAX_BYTES = 2097152;

/** A receipt as it is read: its type, its size in bytes, and the store's link. */
export interface Receipt {
  type: ReceiptType;
  size: number;
  url: string;
}

const SIGNATURES: readonly { type: ReceiptType; bytes: readonly number[] }[] = [
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/**
 * The type of a receipt, read from its first bytes: a JPEG starts `FF D8 FF`, a PNG with the eight bytes of its
 * signature. `undefined` for anything else, and for a file that is empty or larger than 2 MB.
 */
export function receiptTypeOf(bytes: Buffer): ReceiptType | undefined {
  if (bytes.length < 1 || bytes.length > RECEIPT_MAX_BYTES) {
    return undefined;
  }
  const signature = SIGNATURES.find(({ bytes: expected }) =>
    expected.every((byte, position) => bytes[position] === byte),
  );
  return signature?.type;
}

/**
 * Attaches `bytes` to the expense `expenseId` as its receipt, for its editors: its payer or its group's owner, as
 * an edit is allowed. The receipt replaces the one the expense had, and the expense keeps its version.
 *
 * The editor is checked first, then the file, and nothing is sent to the store for a refused request. The
 * file is stored first, outside any transaction, since the store is slow; the receipt is then kept in one
 * transaction that checks the editor again. A store that does not answer `201 { id, url }` within the timeout
 * refuses the request, and nothing is kept.
 */
export async function attachReceipt(
  db: Database,
  config: ReceiptsConfig,
  expenseId: string,
  accountId: string,
  bytes: Buffer,
): Promise<void> {
  requireEditor(db, expenseId, accountId);
  if (config.url === '') {
    throw new Refusal(409, 'ReceiptsNotConfigured', 'Receipts are not set up on this server.');
  }
  const type = receiptTypeOf(bytes);
  if (type === undefined) {
    throw new Refusal(
      422,
      'NotAReceipt',
      'A receipt is a JPEG or a PNG file of 1 byte to 2 MB (2 097 152 bytes): nothing was kept.',
    );
  }
  const stored = await storeFile(config, type, bytes);
  if (stored === undefined) {
    throw new Refusal(
      409,
      'ReceiptNotStored',
      'The receipts store did not keep the file: nothing was kept. Try again.',
    );
  }
  inTransaction(db, () => {
    requireEditor(db, expenseId, accountId);
    db.prepare(
      `INSERT INTO receipts (expense_id, type, size, url, store_id, attached_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (expense_id) DO UPDATE SET
         type = excluded.type, size = excluded.size, url = excluded.url,
         store_id = excluded.store_id, attached_at = excluded.attached_at`,
    ).run(expenseId, type, bytes.length, stored.url, stored.id, new Date().toISOString());
  });
}

/** `POST {url}/files`, the file as the body. Anything but `201 { id, url }` in time is `undefined`. */
async function storeFile(
  config: ReceiptsConfig,
  type: ReceiptType,
  bytes: Buffer,
): Promise<{ id: string; url: string } | undefined> {
  try {
    const response = await fetch(`${config.url}/files`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: new Uint8Array(bytes),
      // Covers the whole exchange, the answer's body included.
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status !== 201) {
      return undefined;
    }
    const answer = (await response.json()) as unknown;
    if (typeof answer !== 'object' || answer === null) {
      return undefined;
    }
    const { id, url } = answer as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof url !== 'string' || url === '') {
      return undefined;
    }
    return { id, url };
  } catch {
    return undefined;
  }
}

/**
 * The receipt of the expense `expenseId`, for a member of its group. Anyone else is refused as if the expense did
 * not exist; an expense without a receipt is refused with `404`. Reading it changes nothing.
 */
export function requireReceipt(db: Database, expenseId: string, accountId: string): Receipt {
  requireExpense(db, expenseId, accountId);
  const row = db.prepare('SELECT type, size, url FROM receipts WHERE expense_id = ?').get(expenseId) as
    { type: ReceiptType; size: number; url: string } | undefined;
  if (row === undefined) {
    throw new Refusal(404, 'NotFound', 'The expense has no receipt.');
  }
  return { type: row.type, size: row.size, url: row.url };
}
