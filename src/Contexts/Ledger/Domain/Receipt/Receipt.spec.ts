import { Id } from '@Architecture/Domain';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { MAX_RECEIPT_BYTES, ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `size` bytes that starts with `start`. */
function fileStarting(start: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(start);
  return bytes;
}

describe('ReceiptFile', () => {
  it('reads a JPEG from its first three bytes and a PNG from its eight', () => {
    expect(ReceiptFile.read(fileStarting(JPEG_START, 10)).data?.type).toBe('image/jpeg');
    expect(ReceiptFile.read(fileStarting(PNG_START, 10)).data?.type).toBe('image/png');
  });

  it('reads the size in bytes, and accepts exactly 2 MB', () => {
    const file = ReceiptFile.read(fileStarting(JPEG_START, MAX_RECEIPT_BYTES));
    expect(file.data?.size).toBe(2097152);
  });

  it('refuses an empty file, and one of 2 MB and 1 byte, by name', () => {
    expect(ReceiptFile.read(new Uint8Array(0)).error?.type).toBe('InvalidReceiptSize');
    expect(ReceiptFile.read(fileStarting(JPEG_START, MAX_RECEIPT_BYTES + 1)).error?.type).toBe('InvalidReceiptSize');
  });

  it('refuses any other file by name, a PNG signature cut short included', () => {
    expect(ReceiptFile.read(new TextEncoder().encode('GIF89a......')).error?.type).toBe('UnsupportedReceiptType');
    expect(ReceiptFile.read(fileStarting(PNG_START.slice(0, 7), 7)).error?.type).toBe('UnsupportedReceiptType');
    expect(ReceiptFile.read(fileStarting([0xff, 0xd8], 2)).error?.type).toBe('UnsupportedReceiptType');
  });
});

describe('Receipt', () => {
  const payer = new Id('payer');
  const owner = new Id('owner');
  const other = new Id('other');
  const at = new Date('2026-11-18T10:00:00.000Z');
  const jpeg = ReceiptFile.read(fileStarting(JPEG_START, 100)).data!;
  const png = ReceiptFile.read(fileStarting(PNG_START, 100)).data!;

  it('lets the payer and the owner attach, and refuses any other member by name', () => {
    const groupMembers = [payer, owner, other];
    const judge = (by: Id, byOwner: boolean) =>
      Receipt.mayBeAttachedBy({
        by,
        byOwner,
        payer,
        expenseMembers: [payer, other],
        groupMembers,
        groupArchived: false,
      });
    expect(judge(payer, false).isFailure()).toBe(false);
    expect(judge(owner, true).isFailure()).toBe(false);
    expect(judge(other, false).error?.type).toBe('NotAllowedToAttachReceipt');
  });

  it('refuses an expense that concerns a member who has left, by name', () => {
    const result = Receipt.mayBeAttachedBy({
      by: payer,
      byOwner: false,
      payer,
      expenseMembers: [payer, other],
      groupMembers: [payer],
      groupArchived: false,
    });
    expect(result.error?.type).toBe('FormerMemberInExpense');
  });

  it('refuses an attachment in an archived group by GroupArchived, before anything is kept', () => {
    const judged = Receipt.mayBeAttachedBy({
      by: owner,
      byOwner: true,
      payer,
      expenseMembers: [payer, other],
      groupMembers: [payer, owner, other],
      groupArchived: true,
    });
    expect(judged.error?.type).toBe('GroupArchived');

    const attached = Receipt.attach({
      expenseId: new Id('expense'),
      file: jpeg,
      stored: { id: 'file-1', url: 'https://receipts.example/file-1' },
      groupArchived: true,
      at,
    });
    expect(attached.isFailure()).toBe(true);
    expect(attached.error?.type).toBe('GroupArchived');

    const stored = Receipt.fromSnapshot({
      id: 'r',
      expenseId: 'e',
      type: 'image/png',
      size: 5,
      storedId: 'f',
      url: 'https://receipts.example/f',
      attachedAt: at.toISOString(),
      version: 2,
    });
    const replaced = stored.replaceWith({
      file: png,
      stored: { id: 'file-2', url: 'https://receipts.example/file-2' },
      groupArchived: true,
      at,
    });
    expect(replaced.error?.type).toBe('GroupArchived');
    expect(stored.toSnapshot()).toMatchObject({ storedId: 'f', version: 2 });
  });

  it('is created with an identity of its own, at version 0, recording ReceiptAttached', () => {
    const receipt = Receipt.attach({
      expenseId: new Id('expense'),
      file: jpeg,
      stored: { id: 'file-1', url: 'https://receipts.example/file-1' },
      groupArchived: false,
      at,
    }).data!;
    expect(receipt.version).toBe(0);
    expect(receipt.toSnapshot()).toMatchObject({
      type: 'image/jpeg',
      size: 100,
      url: 'https://receipts.example/file-1',
    });
    expect(receipt.pullDomainEvents()).toHaveLength(1);
  });

  it('replaces the receipt it had at the version it was read at, under the same identity', () => {
    const first = Receipt.attach({
      expenseId: new Id('expense'),
      file: jpeg,
      stored: { id: 'file-1', url: 'https://receipts.example/file-1' },
      groupArchived: false,
      at,
    }).data!;
    const stored = Receipt.fromSnapshot({ ...first.toSnapshot(), version: 3 });
    const replaced = stored.replaceWith({
      file: png,
      stored: { id: 'file-2', url: 'https://receipts.example/file-2' },
      groupArchived: false,
      at,
    }).data!;
    expect(replaced._id.value).toBe(stored._id.value);
    expect(replaced.version).toBe(3);
    expect(replaced.toSnapshot()).toMatchObject({ type: 'image/png', storedId: 'file-2' });
  });

  it('refuses a link the store did not give, by name', () => {
    const result = Receipt.attach({
      expenseId: new Id('expense'),
      file: jpeg,
      stored: { id: '', url: 'https://receipts.example/x' },
      groupArchived: false,
      at,
    });
    expect(result.error?.type).toBe('ReceiptStoreUnavailable');
  });

  it('reconstitutes a stored receipt without recording anything, and refuses corrupted data by throwing', () => {
    const snapshot = {
      id: 'r',
      expenseId: 'e',
      type: 'image/png' as const,
      size: 5,
      storedId: 'f',
      url: 'https://receipts.example/f',
      attachedAt: at.toISOString(),
      version: 2,
    };
    const receipt = Receipt.fromSnapshot(snapshot);
    expect(receipt.toSnapshot()).toEqual(snapshot);
    expect(() => Receipt.fromSnapshot({ ...snapshot, size: 0 })).toThrow('Corrupted receipt');
  });
});
