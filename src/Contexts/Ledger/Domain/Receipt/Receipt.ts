import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { ExpenseOfFormerMemberException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';
import { IReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { ReceiptNotKeptException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { ReceiptFile, RECEIPT_TYPES } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** What a receipt decides with of its expense: its group, its payer, and the members it concerns (the payer and its split). */
export interface ReceiptExpense {
  id: string;
  groupId: string;
  paidBy: string;
  memberIds: string[];
}

/**
 * Receipt is the aggregate root of the receipt of one expense (request 26): a JPEG or a PNG of at most 2 MB, kept in the receipts
 * store and read at its link. An expense has at most one; attaching one replaces the one it had (the same id, the version read).
 * A receipt is not an edit, so the expense keeps its version.
 *
 * Who may attach one is the expense's rule: its payer or the group's owner, and no former member among the expense's members,
 * as an expense may not change once one of its members has left (request 9). `mayAttach` decides it before the file is sent
 * anywhere; `attach` decides it again with the link the store kept, and records ReceiptAttached.
 */
export class Receipt extends AggregateRoot {
  readonly #expenseId: string;
  readonly #groupId: string;
  readonly #type: ReceiptFile['type'];
  readonly #size: number;
  readonly #url: string;
  readonly #attachedBy: string;

  private constructor(
    id: Id,
    expenseId: string,
    groupId: string,
    type: ReceiptFile['type'],
    size: number,
    url: string,
    attachedBy: string,
    version: number,
  ) {
    super(id, version);
    this.#expenseId = expenseId;
    this.#groupId = groupId;
    this.#type = type;
    this.#size = size;
    this.#url = url;
    this.#attachedBy = attachedBy;
  }

  /**
   * Whether `attachedBy` may attach a receipt to the expense: the expense's payer, or the group's owner, and only while no member
   * the expense concerns has left the group. Refused as a failed Result; decided before the file is sent to the store.
   */
  static mayAttach({
    expense,
    members,
    attachedBy,
  }: {
    expense: ReceiptExpense;
    members: GroupMember[];
    attachedBy: string;
  }): IResult<void> {
    const may =
      attachedBy === expense.paidBy ||
      members.some(member => member.memberId === attachedBy && member.role === 'owner');
    if (!may) {
      return Result.fail(
        new NotAllowedException('Ledger', 'Only the payer or the group’s owner may attach a receipt to an expense'),
      );
    }

    const current = new Set(members.map(member => member.memberId));
    if (expense.memberIds.some(memberId => !current.has(memberId))) {
      return Result.fail(new ExpenseOfFormerMemberException());
    }
    return Result.ok();
  }

  /**
   * Attaches `file`, which the store kept at `url`, to the expense, replacing `current` when the expense has one. Refused when
   * `mayAttach` refuses it, or when no link was kept. Records ReceiptAttached with the id the receipt has.
   */
  static attach({
    expense,
    members,
    attachedBy,
    file,
    url,
    current,
  }: {
    expense: ReceiptExpense;
    members: GroupMember[];
    attachedBy: string;
    file: ReceiptFile;
    url: string;
    current: Receipt | null;
  }): IResult<Receipt> {
    const may = Receipt.mayAttach({ expense, members, attachedBy });
    if (may.isFailure()) return Result.fail(may.error);
    if (url.length === 0) return Result.fail(new ReceiptNotKeptException());

    const attached = current
      ? new Receipt(current._id, expense.id, expense.groupId, file.type, file.size, url, attachedBy, current.version)
      : new Receipt(Id.generate(), expense.id, expense.groupId, file.type, file.size, url, attachedBy, 0);
    attached.record(
      ReceiptAttachedEvent.set({
        receiptId: attached._id.value,
        expenseId: expense.id,
        groupId: expense.groupId,
        type: file.type,
        size: file.size,
        attachedBy,
      }),
    );
    return Result.ok(attached);
  }

  /** Rebuilds a receipt from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IReceiptSnapshot): Receipt {
    if (
      !snapshot.expenseId ||
      !snapshot.groupId ||
      !(RECEIPT_TYPES as readonly string[]).includes(snapshot.type) ||
      !Number.isInteger(snapshot.size) ||
      snapshot.size < 1 ||
      !snapshot.url
    ) {
      throw new Error(`Corrupted receipt ${snapshot._id}`);
    }
    return new Receipt(
      new Id(snapshot._id),
      snapshot.expenseId,
      snapshot.groupId,
      snapshot.type,
      snapshot.size,
      snapshot.url,
      snapshot.attachedBy,
      snapshot.version,
    );
  }

  toSnapshot(): IReceiptSnapshot {
    return {
      _id: this._id.value,
      expenseId: this.#expenseId,
      groupId: this.#groupId,
      type: this.#type,
      size: this.#size,
      url: this.#url,
      attachedBy: this.#attachedBy,
      version: this.version,
    };
  }

  get expenseId(): string {
    return this.#expenseId;
  }
}
