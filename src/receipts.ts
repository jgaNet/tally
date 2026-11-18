import type { Database, Querier } from './database';
import { expenseChangeableBy, findExpenseOfMember } from './expenses';
import { assertNotArchived, findGroupOfMember } from './groups';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

/**
 * The receipts store Tally keeps receipts in: `url` is the base of its API (without a trailing slash), absent when no
 * store is configured; `timeoutMs` is how long the store has to answer (5000 by default).
 */
export interface ReceiptsConfig {
  readonly url: string | undefined;
  readonly timeoutMs: number;
}

/** A receipt is a file of at most 2 MB: 2 097 152 bytes. */
export const MAX_RECEIPT_BYTES = 2_097_152;

/** The types a receipt may have. */
export const RECEIPT_TYPES = ['image/jpeg', 'image/png'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** What a receipt is read as: its type, its size in bytes, and the link the store reads it at. */
export interface Receipt {
  readonly type: ReceiptType;
  readonly size: number;
  readonly url: string;
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The type of the file, read from its first bytes: a JPEG starts with `FF D8 FF`, a PNG with its eight signature
 * bytes. `undefined` when it is neither, so an empty file is neither too.
 */
export function receiptTypeOf(bytes: Buffer): ReceiptType | undefined {
  if (bytes.subarray(0, JPEG_START.length).equals(JPEG_START)) return 'image/jpeg';
  if (bytes.subarray(0, PNG_START.length).equals(PNG_START)) return 'image/png';
  return undefined;
}

/** The file the store has kept: its id there, and the link it is read at. */
interface StoredFile {
  readonly id: string;
  readonly url: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function storedFileOf(value: unknown): StoredFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, url } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && typeof url === 'string' && url.length > 0 ? { id, url } : undefined;
}

/**
 * Sends the file to the store as `POST {url}/files`, its type as the `Content-Type`, and answers what the store kept
 * when it answers `201 { id, url }` within the time limit (the body is read inside it too). Any other answer, an answer
 * that is not that shape, and no answer in time are refused with `424`, and nothing is kept; so is no store configured.
 */
async function storeFile(receipts: ReceiptsConfig, type: ReceiptType, bytes: Buffer): Promise<StoredFile> {
  if (receipts.url === undefined) {
    throw new Refusal(
      424,
      'ReceiptsNotConfigured',
      'Attaching a receipt needs the receipts store, which is not configured.',
    );
  }
  try {
    const response = await fetch(`${receipts.url}/files`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(receipts.timeoutMs),
    });
    const text = await response.text();
    const stored = response.status === 201 ? storedFileOf(parseJson(text)) : undefined;
    if (stored) return stored;
  } catch {
    // No answer in time, or none at all: refused below, as every other answer is.
  }
  throw new Refusal(424, 'ReceiptsUnavailable', 'The receipts store did not keep the receipt. Nothing was kept.');
}

/**
 * Attaches the file to the expense, as its payer or the group's owner does (the rules of an edit, see
 * {@link expenseChangeableBy}): the file is a JPEG or a PNG (by its first bytes), and it is kept at the store before the
 * expense keeps it. The receipt replaces the one the expense had; the expense keeps its version. A file that is empty or
 * not a JPEG or a PNG is refused with `422`, and the store is not asked. Who may not attach is refused as an edit is
 * (`404`, `403`, `409`), before the store is asked; an archived group refuses it as `GroupIsArchived`, before anything
 * else. Nothing is kept when the store does not keep the file.
 */
export async function attachReceipt(
  db: Database,
  receipts: ReceiptsConfig,
  input: { expenseId: string; editorId: string; bytes: Buffer },
): Promise<void> {
  const { expenseId, editorId, bytes } = input;
  const expense = await findExpenseOfMember(db, editorId, expenseId);
  const group = expense && (await findGroupOfMember(db, editorId, expense.groupId));
  if (group) assertNotArchived(group);
  if (bytes.length === 0) throw new Refusal(422, 'ReceiptIsEmpty', 'A receipt is a file of at least one byte.');
  const type = receiptTypeOf(bytes);
  if (type === undefined) {
    throw new Refusal(422, 'ReceiptIsNotJpegOrPng', 'A receipt is a JPEG or a PNG: its first bytes say which.');
  }
  await expenseChangeableBy(db, editorId, expenseId);
  const stored = await storeFile(receipts, type, bytes);
  // The rules are checked again in the transaction that keeps the receipt: the expense may have changed meanwhile.
  await inTransaction(db, async tx => {
    await expenseChangeableBy(tx, editorId, expenseId);
    await tx
      .prepare(
        `INSERT INTO receipts (expense_id, store_id, type, size, url, attached_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (expense_id) DO UPDATE SET store_id = excluded.store_id, type = excluded.type,
           size = excluded.size, url = excluded.url, attached_at = excluded.attached_at`,
      )
      .run(expenseId, stored.id, type, bytes.length, stored.url, new Date().toISOString());
  });
}

/**
 * The receipt of the expense, as a member of its group reads it. To anyone who is not a member the expense does not
 * exist (`404`); an expense with no receipt is `404` too. Reading changes nothing and asks the store nothing.
 */
export async function receiptOfMember(db: Querier, accountId: string, expenseId: string): Promise<Receipt> {
  if (!(await findExpenseOfMember(db, accountId, expenseId))) {
    throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
  }
  const row = await db
    .prepare('SELECT type, size, url FROM receipts WHERE expense_id = ?')
    .get<{ type: ReceiptType; size: number; url: string }>(expenseId);
  if (!row) throw new Refusal(404, 'ReceiptNotFound', 'The expense has no receipt.');
  return { type: row.type, size: Number(row.size), url: row.url };
}
