import { IResult, Result } from '@Architecture/Domain';

import { InvalidReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** The types a receipt may be: a JPEG or a PNG (request 26). */
export type ReceiptType = 'image/jpeg' | 'image/png';

/** The largest receipt, in bytes: 2 MB. */
export const MAX_RECEIPT_BYTES = 2_097_152;

const JPEG_START = [0xff, 0xd8, 0xff];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A file a receipt may be made of, read from the bytes as they were sent: its type is what its first bytes say, never a header, and
 * its size is its length. Only a JPEG or a PNG of 1 byte to 2 MB is one; anything else is refused before anything is kept.
 */
export class ReceiptFile {
  private constructor(
    readonly type: ReceiptType,
    readonly size: number,
  ) {}

  /** A file as it was kept: its type and size, as they were checked when it was attached. */
  static restore(type: ReceiptType, size: number): ReceiptFile {
    return new ReceiptFile(type, size);
  }

  static inspect(bytes: Uint8Array): IResult<ReceiptFile> {
    if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) return Result.fail(new InvalidReceiptFile());
    if (startsWith(bytes, JPEG_START)) return Result.ok(new ReceiptFile('image/jpeg', bytes.length));
    if (startsWith(bytes, PNG_START)) return Result.ok(new ReceiptFile('image/png', bytes.length));
    return Result.fail(new InvalidReceiptFile());
  }
}

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);
