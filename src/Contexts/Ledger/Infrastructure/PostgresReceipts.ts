import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { IReceipts } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceipts';

/**
 * The receipts' table (request 26, docs/adr/0025): one row per receipt, its expense unique, so an expense has one receipt at most. The file is
 * kept by the receipts store; the row keeps its type, its size and the link it is read at.
 */
export const RECEIPT_SCHEMA =
  'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, expense_id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, url TEXT NOT NULL, attached_by TEXT NOT NULL, version INTEGER NOT NULL)';

/** A receipt's row, as the store reads it. */
export type ReceiptRow = {
  id: string;
  expense_id: string;
  group_id: string;
  type: string;
  size: number;
  url: string;
  attached_by: string;
  version: number;
};

/** The columns a receipt row is read by, in the order `ReceiptRow` lists them. */
export const RECEIPT_COLUMNS = 'id, expense_id, group_id, type, size, url, attached_by, version';

/** The snapshot a row keeps: the aggregate is read back from it, and checks what it is given. */
export function receiptSnapshotOf(row: ReceiptRow): ReceiptSnapshot {
  return {
    id: String(row.id),
    expenseId: String(row.expense_id),
    groupId: String(row.group_id),
    type: String(row.type) as ReceiptSnapshot['type'],
    size: Number(row.size),
    url: String(row.url),
    attachedBy: String(row.attached_by),
    version: Number(row.version),
  };
}

/**
 * The receipts' store over PostgreSQL. Its methods run inside a transaction: the use case's. A save of a receipt read at a version another writer
 * has moved past, or a second receipt for an expense, changes nothing and answers a conflict (CONC-OPTIMISTIC).
 */
export class PostgresReceipts implements IReceipts {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareReceiptSchema);
  }

  async findByExpense(expenseId: string): Promise<Receipt | undefined> {
    this.database.assertInTransaction();
    const row = await this.database.get<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE expense_id = ?`, [
      expenseId,
    ]);
    return row ? Receipt.fromSnapshot(receiptSnapshotOf(row)) : undefined;
  }

  async save(receipt: Receipt): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = receipt.toSnapshot();
    if (snapshot.version === 0) {
      const { changes } = await this.database.run(
        'INSERT INTO receipts (id, expense_id, group_id, type, size, url, attached_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (expense_id) DO NOTHING',
        [
          snapshot.id,
          snapshot.expenseId,
          snapshot.groupId,
          snapshot.type,
          snapshot.size,
          snapshot.url,
          snapshot.attachedBy,
          snapshot.version + 1,
        ],
      );
      return changes === 0 ? Result.fail(changedSinceRead()) : Result.ok(undefined);
    }
    const { changes } = await this.database.run(
      'UPDATE receipts SET type = ?, size = ?, url = ?, attached_by = ?, version = ? WHERE id = ? AND version = ?',
      [
        snapshot.type,
        snapshot.size,
        snapshot.url,
        snapshot.attachedBy,
        snapshot.version + 1,
        snapshot.id,
        snapshot.version,
      ],
    );
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }
}

/** Makes the receipts' table what the store reads: created once, when the database is prepared. */
export async function prepareReceiptSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(RECEIPT_SCHEMA);
}

const changedSinceRead = () => new ConcurrencyConflictException('Ledger', 'The receipt changed since it was read');
