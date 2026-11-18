import { AggregateRoot, Id } from '@Architecture/Domain';

import { ReceiptAttachedEvent } from './ReceiptEvents';
import { ReceiptType } from './ReceiptFile';

/** A receipt as it is stored: its id, the expense it is for, its type and size, the link the store keeps it at, and the version it was read at. */
export interface ReceiptSnapshot {
  id: string;
  expenseId: string;
  type: ReceiptType;
  size: number;
  url: string;
  version: number;
}

/** A receipt's file as it is attached: its type and size, read from the bytes, and the link the store answered. */
export interface AttachedFile {
  type: ReceiptType;
  size: number;
  url: string;
}

/**
 * The receipt of an expense (request 26): one per expense, its own aggregate, so that attaching one is not an edit and the expense keeps
 * its version. Attaching one again replaces the one the expense had, under the same id. The link is what the receipts store answered
 * (a plain value, DOMAIN-NON-DETERMINISM). It carries the version it was loaded at, and its repository refuses to save it over a newer one
 * (CONC-OPTIMISTIC).
 */
export class Receipt extends AggregateRoot {
  readonly #expenseId: string;
  #type: ReceiptType;
  #size: number;
  #url: string;

  private constructor(id: Id, version: number, expenseId: string, file: AttachedFile) {
    super(id, version);
    this.#expenseId = expenseId;
    this.#type = file.type;
    this.#size = file.size;
    this.#url = file.url;
  }

  /**
   * The first receipt of an expense, its id generated here. Records `ReceiptAttached`. It is named for what it does, not `create()`: a
   * factory named `create` in a context is read by the storm checker as the behaviour of every other `create` of that context.
   */
  static attachFirst({ expenseId, ...file }: { expenseId: string } & AttachedFile): Receipt {
    const receipt = new Receipt(Id.generate(), 0, expenseId, file);
    receipt.record(
      ReceiptAttachedEvent.set({ receiptId: receipt._id.value, expenseId, type: file.type, size: file.size }),
    );
    return receipt;
  }

  /** Rebuilds a receipt as it was stored. Records nothing, and throws on data no `create()` could have made. */
  static fromSnapshot(snapshot: ReceiptSnapshot): Receipt {
    const valid =
      (snapshot.type === 'image/jpeg' || snapshot.type === 'image/png') &&
      Number.isInteger(snapshot.size) &&
      snapshot.size >= 1 &&
      snapshot.url.length > 0 &&
      Number.isInteger(snapshot.version) &&
      snapshot.version >= 1;
    if (!valid) throw new Error(`The stored receipt ${snapshot.id} is corrupted`);
    return new Receipt(new Id(snapshot.id), snapshot.version, snapshot.expenseId, snapshot);
  }

  /** The expense now has this file instead of the one it had: the same receipt, its link and size changed. Records `ReceiptAttached`. */
  attach(file: AttachedFile): void {
    this.#type = file.type;
    this.#size = file.size;
    this.#url = file.url;
    this.record(
      ReceiptAttachedEvent.set({
        receiptId: this._id.value,
        expenseId: this.#expenseId,
        type: this.#type,
        size: this.#size,
      }),
    );
  }

  toSnapshot(): ReceiptSnapshot {
    return {
      id: this._id.value,
      expenseId: this.#expenseId,
      type: this.#type,
      size: this.#size,
      url: this.#url,
      version: this.version,
    };
  }
}
