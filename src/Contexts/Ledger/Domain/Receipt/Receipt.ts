import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';
import { ReceiptFile, ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { NotAllowedToAttachReceipt, ReceiptStoreUnavailable } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { FormerMemberInExpense } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';

/** What the receipts store answered when it kept a file: its id there, and the link it is read at. */
export interface StoredReceiptFile {
  id: string;
  url: string;
}

/** A receipt as it is stored and reconstituted: plain values, its version included. */
export interface ReceiptSnapshot {
  id: string;
  expenseId: string;
  type: ReceiptType;
  size: number;
  storedId: string;
  url: string;
  attachedAt: string;
  version: number;
}

/**
 * The receipt of an expense (request 26, ADR 19): a JPEG or a PNG the payer or the owner attached, kept in the receipts store,
 * with its type, its size and the link it is read at. One per expense: attaching another replaces it, as `replaceWith()` does,
 * keeping the identity and the version it was read at. The expense itself is not changed. `mayBeAttachedBy()` is the rule
 * the expense's edit has (only its payer or the owner of its group, and no member who has left), asked before the file is
 * sent anywhere. Every operation answers a new instance; the repository stores it at version + 1.
 */
export class Receipt extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly expenseId: Id,
    readonly type: ReceiptType,
    readonly size: number,
    readonly storedId: string,
    readonly url: string,
    readonly attachedAt: Date,
  ) {
    super(id, version);
  }

  /**
   * Whether a caller may attach a receipt to an expense: its payer or the owner of its group (`by`, `byOwner`), and every
   * member of its split still in the group (`expenseMembers` and `groupMembers`, the members now). Records nothing.
   */
  static mayBeAttachedBy({
    by,
    byOwner,
    payer,
    expenseMembers,
    groupMembers,
    groupArchived,
  }: {
    by: Id;
    byOwner: boolean;
    payer: Id;
    expenseMembers: readonly Id[];
    groupMembers: readonly Id[];
    groupArchived: boolean;
  }): IResult {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!byOwner && !payer.equals(by)) return Result.fail(new NotAllowedToAttachReceipt());
    const former = expenseMembers.some(member => !groupMembers.some(current => current.equals(member)));
    if (former) return Result.fail(new FormerMemberInExpense());
    return Result.ok();
  }

  /** Attaches the first receipt of an expense: its identity is generated here, and ReceiptAttached is recorded. */
  static attach({
    expenseId,
    file,
    stored,
    groupArchived,
    at,
  }: {
    expenseId: Id;
    file: ReceiptFile;
    stored: StoredReceiptFile;
    groupArchived: boolean;
    at: Date;
  }): IResult<Receipt> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!validLink(stored)) return Result.fail(new ReceiptStoreUnavailable());
    const receipt = new Receipt(Id.generate(), 0, expenseId, file.type, file.size, stored.id, stored.url, at);
    receipt.record(
      ReceiptAttachedEvent.set({
        receiptId: receipt._id.value,
        expenseId: expenseId.value,
        type: file.type,
        size: file.size,
        attachedAt: at.toISOString(),
      }),
    );
    return Result.ok(receipt);
  }

  /** Replaces the receipt the expense had with `file`, at the version this one was read at; ReceiptAttached is recorded. */
  replaceWith({
    file,
    stored,
    groupArchived,
    at,
  }: {
    file: ReceiptFile;
    stored: StoredReceiptFile;
    groupArchived: boolean;
    at: Date;
  }): IResult<Receipt> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!validLink(stored)) return Result.fail(new ReceiptStoreUnavailable());
    const replaced = new Receipt(
      this._id,
      this.version,
      this.expenseId,
      file.type,
      file.size,
      stored.id,
      stored.url,
      at,
    );
    replaced.record(
      ReceiptAttachedEvent.set({
        receiptId: this._id.value,
        expenseId: this.expenseId.value,
        type: file.type,
        size: file.size,
        attachedAt: at.toISOString(),
      }),
    );
    return Result.ok(replaced);
  }

  /** Reconstitutes a stored receipt. It records nothing, and refuses corrupted data by throwing. */
  static fromSnapshot(snapshot: ReceiptSnapshot): Receipt {
    const attachedAt = new Date(snapshot.attachedAt);
    if (
      !snapshot.id ||
      !snapshot.expenseId ||
      !snapshot.storedId ||
      !snapshot.url ||
      !Number.isInteger(snapshot.size) ||
      snapshot.size < 1 ||
      Number.isNaN(attachedAt.getTime())
    ) {
      throw new Error(`Corrupted receipt ${snapshot.id}`);
    }
    return new Receipt(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.expenseId),
      snapshot.type,
      snapshot.size,
      snapshot.storedId,
      snapshot.url,
      attachedAt,
    );
  }

  toSnapshot(): ReceiptSnapshot {
    return {
      id: this._id.value,
      expenseId: this.expenseId.value,
      type: this.type,
      size: this.size,
      storedId: this.storedId,
      url: this.url,
      attachedAt: this.attachedAt.toISOString(),
      version: this.version,
    };
  }
}

/** The store's answer is a link Tally can keep: an id and a non-empty link. */
function validLink(stored: StoredReceiptFile): boolean {
  return stored.id.length > 0 && stored.url.length > 0;
}
