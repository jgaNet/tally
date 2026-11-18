import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { ReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { ReceiptAttachedEvent } from '@Contexts/Ledger/Domain/Receipt/Events/ReceiptEvents';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/**
 * The receipt of an expense: a JPEG or a PNG of at most 2 MB, kept in the receipts store, read at the link the store gave (request 26,
 * docs/adr/0025). One aggregate per expense, its own: a receipt is not an edit, so the expense keeps its version.
 *
 * Who may attach it is the expense's rule, as for an edit: its payer or the group's owner, among the group's current `members`. The file's
 * type and size are read here, from the bytes the transport handed over as they were sent (`ReceiptFile`), never from a header. `check()` is
 * the decision the use case makes before anything is sent to the store: a file refused is never sent. `attach()` is the first receipt of an
 * expense, `reattach()` the next one, which takes the place of the one it had; each re-checks the same rule and records `ReceiptAttached`.
 * The link is a plain value the store answered: the aggregate checks it is not empty and keeps it.
 *
 * `fromSnapshot()` records nothing and throws on corrupted data. The version is the one the aggregate was read at, which the store checks
 * when it saves it (CONC-OPTIMISTIC); the aggregate never changes it.
 */
export class Receipt extends AggregateRoot {
  readonly #expenseId: string;
  readonly #groupId: string;
  readonly #file: ReceiptFile;
  readonly #url: string;
  readonly #attachedBy: string;

  private constructor(
    id: Id,
    expenseId: string,
    groupId: string,
    file: ReceiptFile,
    url: string,
    attachedBy: string,
    version: number,
  ) {
    super(id, version);
    this.#expenseId = expenseId;
    this.#groupId = groupId;
    this.#file = file;
    this.#url = url;
    this.#attachedBy = attachedBy;
  }

  /**
   * The decision before the store is asked: `by` may attach a receipt to an expense their group has, paid by `paidBy`, and the bytes are a
   * JPEG or a PNG of 1 byte to 2 MB. Its file is the answer; a refusal is `403` (not the payer nor the owner) or `422` (the file).
   */
  static check({
    by,
    members,
    paidBy,
    bytes,
  }: {
    by: string;
    members: GroupMember[];
    paidBy: string;
    bytes: Uint8Array;
  }): IResult<ReceiptFile> {
    if (!mayAttach(by, members, paidBy)) return Result.fail(notAllowedToAttach());
    return ReceiptFile.of(bytes);
  }

  /** The first receipt of an expense: checked, given the link the store kept, and recorded as `ReceiptAttached`. */
  static attach({
    expenseId,
    groupId,
    by,
    members,
    paidBy,
    bytes,
    url,
  }: {
    expenseId: string;
    groupId: string;
    by: string;
    members: GroupMember[];
    paidBy: string;
    bytes: Uint8Array;
    url: string;
  }): IResult<Receipt> {
    const checked = Receipt.check({ by, members, paidBy, bytes });
    if (checked.isFailure()) return checked;
    if (url.length === 0) throw new Error('The receipts store gave a receipt with no link');

    const id = Id.generate();
    const receipt = new Receipt(id, expenseId, groupId, checked.data, url, by, 0);
    receipt.record(ReceiptAttachedEvent.set({ receiptId: id.value, expenseId, groupId, attachedBy: by }));
    return Result.ok(receipt);
  }

  /** The receipt that takes the place of this one, for the same expense: the same rule as `attach()`, and the same identity. */
  reattach({
    by,
    members,
    paidBy,
    bytes,
    url,
  }: {
    by: string;
    members: GroupMember[];
    paidBy: string;
    bytes: Uint8Array;
    url: string;
  }): IResult<Receipt> {
    const checked = Receipt.check({ by, members, paidBy, bytes });
    if (checked.isFailure()) return checked;
    if (url.length === 0) throw new Error('The receipts store gave a receipt with no link');

    const replaced = new Receipt(this._id, this.#expenseId, this.#groupId, checked.data, url, by, this.version);
    replaced.record(
      ReceiptAttachedEvent.set({
        receiptId: this._id.value,
        expenseId: this.#expenseId,
        groupId: this.#groupId,
        attachedBy: by,
      }),
    );
    return Result.ok(replaced);
  }

  static fromSnapshot(snapshot: ReceiptSnapshot): Receipt {
    if (!snapshot.id || !snapshot.expenseId || !snapshot.url) {
      throw new Error(`The receipt ${snapshot.id} is corrupted in the store`);
    }
    return new Receipt(
      new Id(snapshot.id),
      snapshot.expenseId,
      snapshot.groupId,
      ReceiptFile.fromSnapshot(snapshot.type, snapshot.size),
      snapshot.url,
      snapshot.attachedBy,
      snapshot.version,
    );
  }

  toSnapshot(): ReceiptSnapshot {
    return {
      id: this._id.value,
      expenseId: this.#expenseId,
      groupId: this.#groupId,
      type: this.#file.type,
      size: this.#file.size,
      url: this.#url,
      attachedBy: this.#attachedBy,
      version: this.version,
    };
  }
}

/** The payer, or the group's owner, may attach a receipt; any other member may not (request 26, the expense's rule). */
const mayAttach = (by: string, members: GroupMember[], paidBy: string): boolean => {
  if (by === paidBy) return true;
  return members.some(member => member.memberId === by && member.role === 'owner');
};

const notAllowedToAttach = () =>
  new NotAllowedException('Ledger', "Only the payer of an expense or the group's owner may attach its receipt");
