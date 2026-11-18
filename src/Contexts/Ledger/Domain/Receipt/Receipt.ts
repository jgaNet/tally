import { GroupArchived } from '@SharedKernel/Domain';
import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { ExpenseConcernsAFormerMember, NotThePayerOrTheOwner } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';
import { ReceiptNotStored } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { ReceiptFile, ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** What the receipts store kept, as the store answered it: the file's id there, and the link it is read at. A plain value. */
export interface StoredReceipt {
  fileId: string;
  url: string;
}

/** What the expense says that decides who may attach a receipt to it: its payer and the members of its split, read by the handler. */
export interface ReceiptExpense {
  id: Id;
  groupId: Id;
  paidBy: Id;
  /** The payer and every member of the split: each must still be a member of the group. */
  involved: Id[];
}

/** What an attachment is decided on: the expense, the caller and its role, the group's members, the checked file and the stored one. */
export interface AttachInput {
  expense: ReceiptExpense;
  by: Id;
  byOwner: boolean;
  groupMembers: Id[];
  /** Whether the group is archived, read by the handler: an archived group takes no receipt (request 27). */
  archived: boolean;
  file: ReceiptFile;
  stored: StoredReceipt;
}

export interface ReceiptSnapshot {
  id: string;
  expenseId: string;
  groupId: string;
  type: ReceiptType;
  size: number;
  url: string;
  fileId: string;
  version: number;
}

/**
 * The receipt of an expense (request 26): one per expense, kept in the receipts store, the file it is read at. It is its own aggregate, not
 * part of the expense: attaching one is not an edit, so the expense keeps its version. Who may attach one is the expense's rule: its payer or
 * the group's owner, and an expense that concerns no former member. Replacing it keeps its id and its place, at its version + 1 on save.
 */
export class Receipt extends AggregateRoot {
  private constructor(
    id: Id,
    readonly expenseId: Id,
    readonly groupId: Id,
    readonly file: ReceiptFile,
    readonly fileId: string,
    readonly url: string,
    version: number,
  ) {
    super(id, version);
  }

  /**
   * The rule for attaching: the caller is the payer or the group's owner, and every member of the expense's payer and split is still a
   * member of the group. The handler asks it before the file is sent to the store, so a refused attachment sends nothing.
   */
  static attachable({
    expense,
    by,
    byOwner,
    groupMembers,
    archived,
  }: Pick<AttachInput, 'expense' | 'by' | 'byOwner' | 'groupMembers' | 'archived'>): IResult<void> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!byOwner && by.value !== expense.paidBy.value) return Result.fail(new NotThePayerOrTheOwner());
    const isCurrent = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    if (!expense.involved.every(isCurrent)) return Result.fail(new ExpenseConcernsAFormerMember());
    return Result.ok();
  }

  /** Attaches the first receipt of an expense: a new receipt, born with its own id, recording `ReceiptAttached`. */
  static attach(input: AttachInput): IResult<Receipt> {
    const allowed = Receipt.attachable(input);
    if (allowed.isFailure()) return allowed;
    const stored = Receipt.checkStored(input.stored);
    if (stored.isFailure()) return stored;

    const receipt = new Receipt(
      Id.generate(),
      input.expense.id,
      input.expense.groupId,
      input.file,
      input.stored.fileId,
      input.stored.url,
      0,
    );
    receipt.record(
      ReceiptAttachedEvent.set({
        receiptId: receipt._id.value,
        expenseId: receipt.expenseId.value,
        groupId: receipt.groupId.value,
      }),
    );
    return Result.ok(receipt);
  }

  /** Supersedes the receipt the expense had with this one: the same receipt, at the version it was read at, recording `ReceiptAttached`. */
  supersede(input: AttachInput): IResult<Receipt> {
    const allowed = Receipt.attachable(input);
    if (allowed.isFailure()) return allowed;
    const stored = Receipt.checkStored(input.stored);
    if (stored.isFailure()) return stored;

    const replaced = new Receipt(
      this._id,
      this.expenseId,
      this.groupId,
      input.file,
      input.stored.fileId,
      input.stored.url,
      this.version,
    );
    replaced.record(
      ReceiptAttachedEvent.set({
        receiptId: replaced._id.value,
        expenseId: replaced.expenseId.value,
        groupId: replaced.groupId.value,
      }),
    );
    return Result.ok(replaced);
  }

  static fromSnapshot(snapshot: ReceiptSnapshot): Receipt {
    return new Receipt(
      new Id(snapshot.id),
      new Id(snapshot.expenseId),
      new Id(snapshot.groupId),
      ReceiptFile.restore(snapshot.type, snapshot.size),
      snapshot.fileId,
      snapshot.url,
      snapshot.version,
    );
  }

  toSnapshot(): ReceiptSnapshot {
    return {
      id: this._id.value,
      expenseId: this.expenseId.value,
      groupId: this.groupId.value,
      type: this.file.type,
      size: this.file.size,
      url: this.url,
      fileId: this.fileId,
      version: this.version,
    };
  }

  /** The store's answer is a plain value the receipt takes (DOMAIN-NON-DETERMINISM): it must name a file and a link. */
  private static checkStored(stored: StoredReceipt): IResult<void> {
    return stored.fileId && stored.url ? Result.ok() : Result.fail(new ReceiptNotStored());
  }
}
