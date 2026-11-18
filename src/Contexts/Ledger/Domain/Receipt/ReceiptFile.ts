import { IResult, Result } from '@Architecture/Domain';

import { ReceiptNotJpegOrPngException, ReceiptSizeException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** The types a receipt may be: a JPEG or a PNG (request 26). */
export type ReceiptType = 'image/jpeg' | 'image/png';

/** A receipt is at most 2 MB: 2 097 152 bytes, and at least 1 (request 26). */
export const RECEIPT_MAX_BYTES = 2097152;

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The file a receipt is made of: its type, read from the first bytes the file was sent with, and its size in bytes (request 26). A file
 * that is empty or larger than 2 MB is refused, and one that is neither a JPEG nor a PNG. The header of the request is never trusted.
 */
export class ReceiptFile {
  private constructor(
    readonly type: ReceiptType,
    readonly size: number,
  ) {}

  /** The file read from its bytes: refused when it is empty or too large, and when it does not start as a JPEG or a PNG does. */
  static of(bytes: Uint8Array): IResult<ReceiptFile> {
    const size = bytes.length;
    if (size < 1 || size > RECEIPT_MAX_BYTES) return Result.fail(new ReceiptSizeException());
    const type = typeOf(bytes);
    if (type === undefined) return Result.fail(new ReceiptNotJpegOrPngException());
    return Result.ok(new ReceiptFile(type, size));
  }

  /** The file the store kept, read back: it checks what it is given, and throws on corrupted data. */
  static fromSnapshot(type: string, size: number): ReceiptFile {
    if (
      (type !== 'image/jpeg' && type !== 'image/png') ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > RECEIPT_MAX_BYTES
    ) {
      throw new Error(`The receipt of type ${type} and size ${size} is corrupted in the store`);
    }
    return new ReceiptFile(type, size);
  }
}

const typeOf = (bytes: Uint8Array): ReceiptType | undefined => {
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  return undefined;
};

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
