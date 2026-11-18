import { IResult, Result } from '@Architecture/Domain';
import { InvalidReceiptSize, UnsupportedReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** The largest receipt, in bytes (request 26): 2 MB. */
export const MAX_RECEIPT_BYTES = 2_097_152;

export type ReceiptType = 'image/jpeg' | 'image/png';

/** The first bytes of each type of image Tally keeps. */
const SIGNATURES: readonly [ReceiptType, readonly number[]][] = [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
];

/**
 * A receipt's file as the transport handed it over: its bytes as they were sent, its type read from its first bytes (never
 * from a header), its size in bytes. A file that is empty or larger than 2 MB, or whose first bytes are neither a JPEG's nor
 * a PNG's, is refused, and is never sent to the store.
 */
export class ReceiptFile {
  private constructor(
    readonly type: ReceiptType,
    readonly bytes: Uint8Array,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  static read(bytes: Uint8Array): IResult<ReceiptFile> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_RECEIPT_BYTES) return Result.fail(new InvalidReceiptSize());
    const match = SIGNATURES.find(([, signature]) => signature.every((byte, index) => bytes[index] === byte));
    if (!match) return Result.fail(new UnsupportedReceiptType());
    return Result.ok(new ReceiptFile(match[0], bytes));
  }
}
