import { readReceipt, LARGEST_RECEIPT_BYTES } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { Receipt, ReceiptExpense } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';

const JPEG_START = [0xff, 0xd8, 0xff];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytesOf = (start: number[], length = 40) =>
  new Uint8Array([...start, ...new Array(Math.max(0, length - start.length)).fill(1)]);

const expense: ReceiptExpense = { id: 'e1', groupId: 'g1', paidBy: 'ana', memberIds: ['ana', 'bo'] };
const members = [
  { memberId: 'ana', role: 'owner' as const },
  { memberId: 'bo', role: 'member' as const },
  { memberId: 'cy', role: 'member' as const },
];

describe('ReceiptFile: a receipt is a JPEG or a PNG, judged by its first bytes (request 26)', () => {
  it('reads a JPEG and a PNG from their first bytes, with their size', () => {
    expect(readReceipt(bytesOf(JPEG_START))).toMatchObject({ data: { type: 'image/jpeg', size: 40 } });
    expect(readReceipt(bytesOf(PNG_START))).toMatchObject({ data: { type: 'image/png', size: 40 } });
  });

  it('refuses an empty file, one larger than 2 MB, and one that starts with neither signature', () => {
    expect(readReceipt(new Uint8Array(0)).isFailure()).toBe(true);
    expect(readReceipt(bytesOf(JPEG_START, LARGEST_RECEIPT_BYTES + 1)).isFailure()).toBe(true);
    expect(readReceipt(bytesOf(JPEG_START, LARGEST_RECEIPT_BYTES)).isFailure()).toBe(false);
    expect(readReceipt(new Uint8Array([0xff, 0xd8])).isFailure()).toBe(true);
    expect(readReceipt(bytesOf([0x47, 0x49, 0x46])).isFailure()).toBe(true);
  });
});

describe('Receipt: who may attach one, and what it records (request 26)', () => {
  const file = readReceipt(bytesOf(JPEG_START)).data!;

  it('lets the payer and the owner attach, and refuses another member who is neither as not allowed', () => {
    expect(Receipt.mayAttach({ expense, members, attachedBy: 'ana' }).isFailure()).toBe(false);
    expect(Receipt.mayAttach({ expense: { ...expense, paidBy: 'bo' }, members, attachedBy: 'bo' }).isFailure()).toBe(
      false,
    );
    expect(Receipt.mayAttach({ expense: { ...expense, paidBy: 'bo' }, members, attachedBy: 'ana' }).isFailure()).toBe(
      false,
    );

    const refused = Receipt.mayAttach({ expense, members, attachedBy: 'cy' });
    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
  });

  it('refuses an expense that concerns a former member, as an expense may not change', () => {
    const left = Receipt.mayAttach({ expense, members: members.filter(m => m.memberId !== 'bo'), attachedBy: 'ana' });
    expect(left.isFailure() && left.error.type).toBe('ExpenseOfFormerMember');
  });

  it('is a new receipt with its own id and records ReceiptAttached when the expense had none', () => {
    const attached = Receipt.attach({
      expense,
      members,
      attachedBy: 'ana',
      file,
      url: 'http://store/files/1',
      current: null,
    });
    expect(attached.isFailure()).toBe(false);
    const receipt = attached.data!;
    expect(receipt.version).toBe(0);
    expect(receipt.toSnapshot()).toMatchObject({
      expenseId: 'e1',
      type: 'image/jpeg',
      size: 40,
      url: 'http://store/files/1',
    });

    const events = receipt.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(ReceiptAttachedEvent);
  });

  it('replaces the receipt the expense had, keeping its id and the version it was read at', () => {
    const current = Receipt.fromSnapshot({
      _id: 'r1',
      expenseId: 'e1',
      groupId: 'g1',
      type: 'image/jpeg',
      size: 40,
      url: 'http://store/files/1',
      attachedBy: 'ana',
      version: 3,
    });
    const png = readReceipt(bytesOf(PNG_START)).data!;
    const replaced = Receipt.attach({
      expense,
      members,
      attachedBy: 'ana',
      file: png,
      url: 'http://store/files/2',
      current,
    });
    expect(replaced.data!.toSnapshot()).toMatchObject({
      _id: 'r1',
      type: 'image/png',
      url: 'http://store/files/2',
      version: 3,
    });
  });

  it('refuses a receipt when the store kept no link', () => {
    const refused = Receipt.attach({ expense, members, attachedBy: 'ana', file, url: '', current: null });
    expect(refused.isFailure() && refused.error.type).toBe('ReceiptNotKept');
  });

  it('refuses a corrupted snapshot when it is rebuilt', () => {
    expect(() =>
      Receipt.fromSnapshot({
        _id: 'r2',
        expenseId: 'e1',
        groupId: 'g1',
        type: 'image/gif' as 'image/jpeg',
        size: 40,
        url: 'http://store/files/3',
        attachedBy: 'ana',
        version: 1,
      }),
    ).toThrow('Corrupted receipt r2');
  });
});
