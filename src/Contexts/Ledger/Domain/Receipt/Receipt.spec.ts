import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptFile, RECEIPT_MAX_BYTES } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';

const members = [
  { memberId: 'ada', role: 'owner' as const },
  { memberId: 'bob', role: 'member' as const },
  { memberId: 'cy', role: 'member' as const },
];

/** A file of `size` bytes that starts with `head`, the rest zeros. */
const fileStarting = (head: number[], size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return bytes;
};
const JPEG = (size = 64) => fileStarting([0xff, 0xd8, 0xff, 0xe0], size);
const PNG = (size = 64) => fileStarting([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);

describe('ReceiptFile: read from the bytes', () => {
  it('is a JPEG by its first three bytes and a PNG by its eight, of 1 byte to 2 MB', () => {
    expect(ReceiptFile.of(new Uint8Array([0xff, 0xd8, 0xff])).data).toMatchObject({ type: 'image/jpeg', size: 3 });
    expect(ReceiptFile.of(PNG(8)).data).toMatchObject({ type: 'image/png', size: 8 });
    expect(ReceiptFile.of(JPEG(RECEIPT_MAX_BYTES)).isFailure()).toBe(false);
  });

  it('refuses an empty file, or one larger than 2 MB, by its size', () => {
    expect(ReceiptFile.of(new Uint8Array(0)).error).toMatchObject({ type: 'ReceiptSizeOutOfRange' });
    expect(ReceiptFile.of(JPEG(RECEIPT_MAX_BYTES + 1)).error).toMatchObject({ type: 'ReceiptSizeOutOfRange' });
  });

  it('refuses a file that is neither a JPEG nor a PNG, or whose first bytes are only a part of one', () => {
    expect(ReceiptFile.of(fileStarting([0x47, 0x49, 0x46, 0x38], 16)).error).toMatchObject({
      type: 'ReceiptNotJpegOrPng',
    });
    expect(ReceiptFile.of(new Uint8Array([0xff, 0xd8])).error).toMatchObject({ type: 'ReceiptNotJpegOrPng' });
    expect(ReceiptFile.of(fileStarting([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a], 16)).error).toMatchObject({
      type: 'ReceiptNotJpegOrPng',
    });
  });
});

describe('Receipt', () => {
  it("may be attached by the payer, and by the group's owner, and by no other member", () => {
    const attach = (by: string) => Receipt.check({ by, members, paidBy: 'bob', bytes: JPEG() });
    expect(attach('bob').isFailure()).toBe(false);
    expect(attach('ada').isFailure()).toBe(false);
    expect(attach('cy').error).toMatchObject({ type: 'NotAllowed' });
  });

  it('is created with its type, its size and its link, and records ReceiptAttached once', () => {
    const created = Receipt.attach({
      expenseId: 'exp-1',
      groupId: 'flat',
      by: 'bob',
      members,
      paidBy: 'bob',
      bytes: PNG(100),
      url: 'https://receipts.example/files/1',
    });
    expect(created.isFailure()).toBe(false);
    const receipt = created.data as Receipt;
    expect(receipt.toSnapshot()).toMatchObject({
      expenseId: 'exp-1',
      groupId: 'flat',
      type: 'image/png',
      size: 100,
      url: 'https://receipts.example/files/1',
      attachedBy: 'bob',
      version: 0,
    });
    const events = receipt.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(ReceiptAttachedEvent);
  });

  it('is not created for a refused file, nor for a member who may not attach: nothing is recorded', () => {
    const refused = Receipt.attach({
      expenseId: 'exp-1',
      groupId: 'flat',
      by: 'bob',
      members,
      paidBy: 'bob',
      bytes: fileStarting([0x47, 0x49, 0x46], 8),
      url: 'https://receipts.example/files/2',
    });
    expect(refused.error).toMatchObject({ type: 'ReceiptNotJpegOrPng' });
    const notAllowed = Receipt.attach({
      expenseId: 'exp-1',
      groupId: 'flat',
      by: 'cy',
      members,
      paidBy: 'bob',
      bytes: JPEG(),
      url: 'https://receipts.example/files/3',
    });
    expect(notAllowed.error).toMatchObject({ type: 'NotAllowed' });
  });

  it('replaces the receipt it had: the same identity, the version it was read at, and a new file and link', () => {
    const first = Receipt.attach({
      expenseId: 'exp-1',
      groupId: 'flat',
      by: 'bob',
      members,
      paidBy: 'bob',
      bytes: JPEG(),
      url: 'https://receipts.example/files/1',
    }).data as Receipt;
    const stored = Receipt.fromSnapshot({ ...first.toSnapshot(), version: 1 });
    expect(stored.pullDomainEvents()).toEqual([]);

    const replaced = stored.reattach({
      by: 'ada',
      members,
      paidBy: 'bob',
      bytes: PNG(),
      url: 'https://receipts.example/files/2',
    }).data as Receipt;
    expect(replaced.toSnapshot()).toMatchObject({
      id: first.toSnapshot().id,
      type: 'image/png',
      url: 'https://receipts.example/files/2',
      attachedBy: 'ada',
      version: 1,
    });
    expect(replaced.pullDomainEvents()).toHaveLength(1);
  });

  it('reads back what it kept, and throws on a corrupted row', () => {
    const snapshot = {
      id: 'r1',
      expenseId: 'exp-1',
      groupId: 'flat',
      type: 'image/jpeg' as const,
      size: 10,
      url: 'https://receipts.example/files/1',
      attachedBy: 'bob',
      version: 2,
    };
    expect(Receipt.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
    expect(() => Receipt.fromSnapshot({ ...snapshot, type: 'image/gif' as never })).toThrow();
    expect(() => Receipt.fromSnapshot({ ...snapshot, size: 0 })).toThrow();
  });
});
