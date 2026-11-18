import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import {
  InvalidReceiptSizeException,
  UnsupportedReceiptTypeException,
} from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** The types a receipt may be, read from the first bytes of its file (request 26). */
export type ReceiptType = 'image/jpeg' | 'image/png';

/** The largest receipt, in bytes: 2 MB (request 26). */
export const RECEIPT_MAX_BYTES = 2_097_152;

/** A file as the domain reads it: its type, from its first bytes, and its size in bytes. */
export interface ReceiptFile {
  readonly type: ReceiptType;
  readonly size: number;
}

/**
 * A receipt as the store keeps it: its id, the expense it is of, the file's id and the link it is read at in the receipts store, the file's
 * type and size, and the version it is at.
 */
export interface ReceiptSnapshot {
  readonly id: string;
  readonly expenseId: string;
  readonly fileId: string;
  readonly url: string;
  readonly type: ReceiptType;
  readonly size: number;
  readonly version: number;
}

const JPEG_START: readonly number[] = [0xff, 0xd8, 0xff];
const PNG_START: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Reads a file as a receipt (request 26, the storm's type and size hot spot): it is 1 byte to 2 MB, and its type is read from its first bytes
 * (`FF D8 FF` for a JPEG, the PNG signature for a PNG), never from a header. Pure: a file refused is never sent to the store.
 */
export function examineReceipt(bytes: Uint8Array): IResult<ReceiptFile> {
  if (bytes.length < 1 || bytes.length > RECEIPT_MAX_BYTES) return Result.fail(new InvalidReceiptSizeException());
  if (startsWith(bytes, JPEG_START)) return Result.ok({ type: 'image/jpeg', size: bytes.length });
  if (startsWith(bytes, PNG_START)) return Result.ok({ type: 'image/png', size: bytes.length });
  return Result.fail(new UnsupportedReceiptTypeException());
}

const startsWith = (bytes: Uint8Array, start: readonly number[]): boolean =>
  bytes.length >= start.length && start.every((byte, index) => bytes[index] === byte);

/**
 * The receipt of an expense (request 26, ADR 21): one per expense, its own aggregate, so that attaching one is not an edit of the expense and
 * the expense keeps its version. It is kept with the link the receipts store gave it (a plain value, DOMAIN-NON-DETERMINISM). Its version is the
 * one it was loaded at (AggregateRoot). Who may attach one is the use case's, by the expense's rules.
 */
export class Receipt extends AggregateRoot {
  readonly #expenseId: string;
  #fileId: string;
  #url: string;
  #type: ReceiptType;
  #size: number;

  private constructor(
    id: Id,
    expenseId: string,
    fileId: string,
    url: string,
    type: ReceiptType,
    size: number,
    version: number,
  ) {
    super(id, version);
    this.#expenseId = expenseId;
    this.#fileId = fileId;
    this.#url = url;
    this.#type = type;
    this.#size = size;
  }

  /** A receipt attached to an expense that had none. The identity is generated here (DOMAIN-IDENTITY); records `ReceiptAttached`. */
  static attach(draft: { expenseId: string; fileId: string; url: string; file: ReceiptFile }, now: Date): Receipt {
    const receipt = new Receipt(
      Id.generate(),
      draft.expenseId,
      draft.fileId,
      draft.url,
      draft.file.type,
      draft.file.size,
      0,
    );
    receipt.record(
      ReceiptAttachedEvent.set({
        receiptId: receipt._id.value,
        expenseId: draft.expenseId,
        at: now.toISOString(),
      }),
    );
    return receipt;
  }

  /** The receipt an expense has, replaced by a new file: the same receipt, its id kept, `ReceiptAttached` recorded again. */
  reattach(draft: { fileId: string; url: string; file: ReceiptFile }, now: Date): void {
    this.#fileId = draft.fileId;
    this.#url = draft.url;
    this.#type = draft.file.type;
    this.#size = draft.file.size;
    this.record(
      ReceiptAttachedEvent.set({
        receiptId: this._id.value,
        expenseId: this.#expenseId,
        at: now.toISOString(),
      }),
    );
  }

  /** A receipt the store keeps, as it was last attached. Records nothing; throws on a receipt the domain never keeps. */
  static fromSnapshot(snapshot: ReceiptSnapshot): Receipt {
    if (
      !['image/jpeg', 'image/png'].includes(snapshot.type) ||
      !Number.isSafeInteger(snapshot.size) ||
      snapshot.size < 1 ||
      snapshot.size > RECEIPT_MAX_BYTES ||
      snapshot.url === '' ||
      snapshot.fileId === ''
    ) {
      throw new Error(`The receipt ${snapshot.id} is corrupted`);
    }
    return new Receipt(
      new Id(snapshot.id),
      snapshot.expenseId,
      snapshot.fileId,
      snapshot.url,
      snapshot.type,
      snapshot.size,
      snapshot.version,
    );
  }

  toSnapshot(): ReceiptSnapshot {
    return {
      id: this._id.value,
      expenseId: this.#expenseId,
      fileId: this.#fileId,
      url: this.#url,
      type: this.#type,
      size: this.#size,
      version: this.version,
    };
  }
}

export type ReceiptAttachedPayload = { receiptId: string; expenseId: string; at: string };

/** The fact that a receipt was attached to an expense, or replaced by another file. Made durable with the receipt, published after the commit. */
export class ReceiptAttachedEvent extends DomainEvent<ReceiptAttachedPayload> {}
