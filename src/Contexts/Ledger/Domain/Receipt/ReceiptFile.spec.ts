import { ReceiptFile, MAX_RECEIPT_BYTES } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { InvalidReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

const JPEG_START = [0xff, 0xd8, 0xff];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const padded = (start: number[], length: number) => {
  const bytes = new Uint8Array(length);
  bytes.set(start);
  return bytes;
};

describe('ReceiptFile', () => {
  it('reads a JPEG and a PNG from their first bytes, and its size from the length', () => {
    const jpeg = ReceiptFile.inspect(padded(JPEG_START, 10));
    expect(jpeg.isSuccess() && jpeg.data.type).toBe('image/jpeg');
    expect(jpeg.isSuccess() && jpeg.data.size).toBe(10);

    const png = ReceiptFile.inspect(padded(PNG_START, 20));
    expect(png.isSuccess() && png.data.type).toBe('image/png');
    expect(png.isSuccess() && png.data.size).toBe(20);
  });

  it('keeps a file of exactly 2 MB and refuses one byte more', () => {
    expect(ReceiptFile.inspect(padded(JPEG_START, MAX_RECEIPT_BYTES)).isSuccess()).toBe(true);
    const larger = ReceiptFile.inspect(padded(JPEG_START, MAX_RECEIPT_BYTES + 1));
    expect(larger.isFailure() && larger.error).toBeInstanceOf(InvalidReceiptFile);
  });

  it('refuses an empty file, and anything whose first bytes are not a JPEG or a PNG', () => {
    expect(ReceiptFile.inspect(new Uint8Array(0)).isFailure()).toBe(true);
    expect(ReceiptFile.inspect(new TextEncoder().encode('Groceries, 87 euros')).isFailure()).toBe(true);
    // A PNG signature cut short is not a PNG; a GIF is not a receipt.
    expect(ReceiptFile.inspect(padded(PNG_START.slice(0, 7), 20)).isFailure()).toBe(true);
    expect(ReceiptFile.inspect(new TextEncoder().encode('GIF89a')).isFailure()).toBe(true);
  });
});
