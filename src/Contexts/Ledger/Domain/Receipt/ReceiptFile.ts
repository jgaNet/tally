import { IResult, Result } from '@Architecture/Domain';

import { InvalidReceiptException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** The types a receipt may be: a JPEG or a PNG, and no other (request 26). */
export const RECEIPT_TYPES = ['image/jpeg', 'image/png'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** The largest receipt, in bytes: 2 MB, 2 097 152 bytes (request 26). */
export const LARGEST_RECEIPT_BYTES = 2_097_152;

/** The first bytes each type starts with: the type is read from them, never from a header the client sent. */
const SIGNATURES: { type: ReceiptType; start: number[] }[] = [
  { type: 'image/jpeg', start: [0xff, 0xd8, 0xff] },
  { type: 'image/png', start: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** A file read as a receipt: its type, its size in bytes, and the bytes as they were sent. */
export interface ReceiptFile {
  type: ReceiptType;
  size: number;
  bytes: Uint8Array;
}

/**
 * Reads the bytes a client sent as a receipt. The type is read from the first bytes; a file that is empty, larger than 2 MB, or
 * that starts with neither signature is refused. Decided before anything is sent to the receipts store (request 26).
 */
export function readReceipt(bytes: Uint8Array): IResult<ReceiptFile> {
  if (bytes.length < 1 || bytes.length > LARGEST_RECEIPT_BYTES) return Result.fail(new InvalidReceiptException());

  const signature = SIGNATURES.find(({ start }) => start.every((byte, index) => bytes[index] === byte));
  if (!signature) return Result.fail(new InvalidReceiptException());

  return Result.ok({ type: signature.type, size: bytes.length, bytes });
}
