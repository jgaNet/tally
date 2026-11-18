import { IResult, Result } from '@Architecture/Domain';

import { InvalidReceiptException } from './ReceiptExceptions';

/** The largest receipt Tally keeps: 2 MB, 2 097 152 bytes (request 26). */
export const MAX_RECEIPT_BYTES = 2_097_152;

/** The types of file a receipt may be: a JPEG or a PNG (request 26). */
export type ReceiptType = 'image/jpeg' | 'image/png';

const JPEG_START = [0xff, 0xd8, 0xff];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether the bytes start with the given ones. */
const startsWith = (bytes: Uint8Array, start: readonly number[]): boolean =>
  bytes.length >= start.length && start.every((byte, index) => bytes[index] === byte);

/** The type a file is, read from its first bytes, never from a header the sender gave; `undefined` for any other file. */
export const receiptTypeOf = (bytes: Uint8Array): ReceiptType | undefined => {
  if (startsWith(bytes, JPEG_START)) return 'image/jpeg';
  if (startsWith(bytes, PNG_START)) return 'image/png';
  return undefined;
};

/**
 * What a receipt file is once it is allowed: its type, read from its first bytes, and its size in bytes. A file that is empty, larger than
 * 2 MB, or neither a JPEG nor a PNG is refused, and is never sent to the store (request 26).
 */
export const readReceiptFile = (bytes: Uint8Array): IResult<{ type: ReceiptType; size: number }> => {
  if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) return Result.fail(new InvalidReceiptException());
  const type = receiptTypeOf(bytes);
  if (type === undefined) return Result.fail(new InvalidReceiptException());
  return Result.ok({ type, size: bytes.length });
};
