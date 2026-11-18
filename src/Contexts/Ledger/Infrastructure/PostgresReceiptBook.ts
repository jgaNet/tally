import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase, isUniqueViolation } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IReceiptBook, ReceiptView } from '@Contexts/Ledger/Application/IReceiptBook';
import { Receipt, ReceiptSnapshot, ReceiptType } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * The receipts' table (request 26, ADR 21): one row per receipt, unique per expense, with the file's id and link in the receipts store, its type,
 * its size and the version it is stored at. Created by `CREATE TABLE IF NOT EXISTS`, as every table here. An expense keeps no reference to it.
 */
export const receiptsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS receipts (
     id TEXT PRIMARY KEY,
     expense_id TEXT NOT NULL UNIQUE,
     file_id TEXT NOT NULL,
     url TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png')),
     size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 2097152),
     version INTEGER NOT NULL
   )`,
];

interface ReceiptRow {
  id: string;
  expense_id: string;
  file_id: string;
  url: string;
  type: ReceiptType;
  size: number;
  version: number;
}

const CONFLICT =
  'The receipt changed since it was read, or another receipt of this expense was attached: read it again';

/**
 * The receipts in PostgreSQL. `add` and `save` write inside the command's transaction; `save` only while the receipt is still at the version it was
 * loaded at (the optimistic check, ADR 8). A second receipt for an expense, found only when the unique key refuses a write, is a conflict of the same
 * kind, so the command re-reads and decides again (the receipt then replaces it).
 */
export class PostgresReceiptBook implements IReceiptBook {
  constructor(private readonly database: PostgresDatabase) {}

  async findByExpense(expenseId: string): Promise<Receipt | undefined> {
    const row = (await this.database.writer
      .prepare('SELECT id, expense_id, file_id, url, type, size, version FROM receipts WHERE expense_id = ?')
      .get(expenseId)) as unknown as ReceiptRow | undefined;
    return row ? Receipt.fromSnapshot(this.#snapshotOf(row)) : undefined;
  }

  async add(receipt: Receipt): Promise<void> {
    const snapshot = receipt.toSnapshot();
    try {
      await this.database.writer
        .prepare(
          'INSERT INTO receipts (id, expense_id, file_id, url, type, size, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          snapshot.id,
          snapshot.expenseId,
          snapshot.fileId,
          snapshot.url,
          snapshot.type,
          snapshot.size,
          snapshot.version + 1,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConcurrencyConflictException('Ledger', CONFLICT);
      throw error;
    }
  }

  async save(receipt: Receipt): Promise<void> {
    const snapshot = receipt.toSnapshot();
    const { changes } = await this.database.writer
      .prepare('UPDATE receipts SET file_id = ?, url = ?, type = ?, size = ?, version = ? WHERE id = ? AND version = ?')
      .run(
        snapshot.fileId,
        snapshot.url,
        snapshot.type,
        snapshot.size,
        snapshot.version + 1,
        snapshot.id,
        snapshot.version,
      );
    if (changes === 0) throw new ConcurrencyConflictException('Ledger', CONFLICT);
  }

  async viewOf(expenseId: string): Promise<ReceiptView | undefined> {
    const row = (await this.database.writer
      .prepare('SELECT type, size, url FROM receipts WHERE expense_id = ?')
      .get(expenseId)) as unknown as { type: ReceiptType; size: number; url: string } | undefined;
    return row ? { type: row.type, size: row.size, url: row.url } : undefined;
  }

  #snapshotOf(row: ReceiptRow): ReceiptSnapshot {
    return {
      id: row.id,
      expenseId: row.expense_id,
      fileId: row.file_id,
      url: row.url,
      type: row.type,
      size: row.size,
      version: row.version,
    };
  }
}
