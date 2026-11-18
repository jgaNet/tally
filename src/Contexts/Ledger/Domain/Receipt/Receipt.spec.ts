import { Id } from '@Architecture/Domain';

import { ExpenseConcernsAFormerMember, NotThePayerOrTheOwner } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';
import { ReceiptNotStored } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { Receipt, ReceiptExpense } from '@Contexts/Ledger/Domain/Receipt/Receipt';

const ann = new Id('ann');
const ben = new Id('ben');
const cy = new Id('cy');
const members = [ann, ben, cy];
const expense: ReceiptExpense = {
  id: new Id('taxi'),
  groupId: new Id('flat'),
  paidBy: ben,
  involved: [ben, ann, cy],
};
const jpeg = ReceiptFile.restore('image/jpeg', 120);
const png = ReceiptFile.restore('image/png', 80);
const stored = { fileId: 'file-1', url: 'http://receipts.test/files/file-1' };

const attach = (overrides: Partial<Parameters<typeof Receipt.attach>[0]> = {}) =>
  Receipt.attach({
    expense,
    by: ben,
    byOwner: false,
    archived: false,
    groupMembers: members,
    file: jpeg,
    stored,
    ...overrides,
  });

describe('Receipt', () => {
  it('is attached by the payer, and records ReceiptAttached with the expense and its group', () => {
    const attached = attach();
    expect(attached.isSuccess()).toBe(true);
    if (!attached.isSuccess()) return;
    expect(attached.data.toSnapshot()).toMatchObject({
      expenseId: 'taxi',
      groupId: 'flat',
      type: 'image/jpeg',
      size: 120,
      url: stored.url,
      version: 0,
    });
    const [event] = attached.data.pullDomainEvents();
    expect(event).toBeInstanceOf(ReceiptAttachedEvent);
  });

  it('is attached by the group’s owner, and refused to any other member', () => {
    expect(attach({ by: ann, byOwner: true, archived: false }).isSuccess()).toBe(true);
    const refused = attach({ by: cy, byOwner: false, archived: false });
    expect(refused.isFailure() && refused.error).toBeInstanceOf(NotThePayerOrTheOwner);
  });

  it('is refused when the expense concerns a member who has left', () => {
    const refused = attach({ groupMembers: [ann, ben] });
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ExpenseConcernsAFormerMember);
  });

  it('is refused when the store named no file or no link', () => {
    const refused = attach({ stored: { fileId: '', url: stored.url } });
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ReceiptNotStored);
  });

  it('replaces the receipt an expense had, keeping its id and the version it was read at', () => {
    const first = attach();
    if (!first.isSuccess()) throw new Error('the first attachment must succeed');
    const stale = Receipt.fromSnapshot({ ...first.data.toSnapshot(), version: 3 });

    const replaced = stale.supersede({
      expense,
      by: ben,
      byOwner: false,
      archived: false,
      groupMembers: members,
      file: png,
      stored: { fileId: 'file-2', url: 'http://receipts.test/files/file-2' },
    });
    expect(replaced.isSuccess()).toBe(true);
    if (!replaced.isSuccess()) return;
    expect(replaced.data.toSnapshot()).toMatchObject({
      id: stale._id.value,
      type: 'image/png',
      size: 80,
      fileId: 'file-2',
      version: 3,
    });
  });

  it('restores from its snapshot, and records nothing', () => {
    const restored = Receipt.fromSnapshot({
      id: 'r',
      expenseId: 'taxi',
      groupId: 'flat',
      type: 'image/png',
      size: 80,
      url: 'u',
      fileId: 'f',
      version: 2,
    });
    expect(restored.toSnapshot()).toEqual({
      id: 'r',
      expenseId: 'taxi',
      groupId: 'flat',
      type: 'image/png',
      size: 80,
      url: 'u',
      fileId: 'f',
      version: 2,
    });
    expect(restored.pullDomainEvents()).toEqual([]);
  });
});
