import { describe, expect, it } from '@jest/globals';

import { RECEIPT_MAX_BYTES, Receipt, examineReceipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];
const now = new Date('2026-03-02T10:00:00.000Z');

/** A file of `length` bytes that starts with `start` and is zero after it. */
const fileOf = (start: number[], length = start.length): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(start);
  return bytes;
};

describe('examineReceipt: a receipt is a JPEG or a PNG of 1 byte to 2 MB, read from its first bytes (request 26)', () => {
  it('reads a JPEG from FF D8 FF and a PNG from its signature, with their size in bytes', () => {
    const jpeg = examineReceipt(fileOf(JPEG));
    const png = examineReceipt(fileOf(PNG));
    expect(jpeg.isFailure()).toBe(false);
    expect(jpeg.data).toEqual({ type: 'image/jpeg', size: 6 });
    expect(png.isFailure()).toBe(false);
    expect(png.data).toEqual({ type: 'image/png', size: 9 });
  });

  it('refuses anything else, even a file that says it is an image: a GIF is 422 UnsupportedReceiptType', () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(examineReceipt(gif).isFailure()).toBe(true);
    expect(examineReceipt(Uint8Array.from([0xff, 0xd8])).isFailure()).toBe(true);
  });

  it('refuses an empty file and one over 2 MB (2 097 152 bytes), and accepts exactly 2 MB', () => {
    expect(examineReceipt(new Uint8Array(0)).isFailure()).toBe(true);
    expect(examineReceipt(fileOf(JPEG, RECEIPT_MAX_BYTES + 1)).isFailure()).toBe(true);
    expect(examineReceipt(fileOf(JPEG, RECEIPT_MAX_BYTES)).data).toEqual({
      type: 'image/jpeg',
      size: RECEIPT_MAX_BYTES,
    });
  });
});

describe('Receipt: one per expense, kept with the store’s link (ADR 21)', () => {
  it('attaches a new receipt at version 0 and reattaches it keeping its id', () => {
    const attached = Receipt.attach(
      {
        expenseId: 'expense-1',
        fileId: 'file-1',
        url: 'https://store.example.com/files/file-1',
        file: { type: 'image/jpeg', size: 6 },
      },
      now,
    );
    const first = attached.toSnapshot();
    expect(first).toMatchObject({ expenseId: 'expense-1', fileId: 'file-1', type: 'image/jpeg', size: 6, version: 0 });

    attached.reattach(
      { fileId: 'file-2', url: 'https://store.example.com/files/file-2', file: { type: 'image/png', size: 9 } },
      now,
    );
    expect(attached.toSnapshot()).toMatchObject({
      id: first.id,
      fileId: 'file-2',
      type: 'image/png',
      size: 9,
      version: 0,
    });
  });

  it('is rebuilt from its snapshot, and throws on a receipt the domain never keeps', () => {
    const snapshot = {
      id: 'r-1',
      expenseId: 'expense-1',
      fileId: 'file-1',
      url: 'https://store.example.com/files/file-1',
      type: 'image/png' as const,
      size: 9,
      version: 3,
    };
    expect(Receipt.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
    expect(() => Receipt.fromSnapshot({ ...snapshot, type: 'image/gif' as never })).toThrow();
    expect(() => Receipt.fromSnapshot({ ...snapshot, size: 0 })).toThrow();
  });
});
