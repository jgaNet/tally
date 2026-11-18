import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * The table of receipts (request 26): one row per expense, so an expense has at most one receipt; attaching another replaces
 * the row's file, link and attacher, at the version it was read at. Declared with the database, which makes it when it opens (ADR 20).
 */
export function defineReceiptTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      expense_id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      attached_by TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

interface ReceiptRow {
  id: string;
  expense_id: string;
  group_id: string;
  type: string;
  size: number;
  url: string;
  attached_by: string;
  version: number;
}

/** The receipts as aggregates, over the application's PostgreSQL database, inside the transaction of the command. */
export class PostgresReceiptRepository implements IReceiptRepository {
  constructor(private database: PostgresDatabase) {
    defineReceiptTables(database);
  }

  async findByExpense(expenseId: string): Promise<Receipt | null> {
    const row = await this.database.get<ReceiptRow>('SELECT * FROM receipts WHERE expense_id = ?', [expenseId]);
    if (!row) return null;

    const snapshot: IReceiptSnapshot = {
      _id: row.id,
      expenseId: row.expense_id,
      groupId: row.group_id,
      type: row.type as IReceiptSnapshot['type'],
      size: row.size,
      url: row.url,
      attachedBy: row.attached_by,
      version: row.version,
    };
    return Receipt.fromSnapshot(snapshot);
  }

  /**
   * A new receipt is inserted at version 1, unless its expense already has one stored; a replacement is updated only where the
   * row is still at the version it was read at, as SQL makes the check atomic. Either refusal is a ConcurrencyConflictException.
   */
  async save(receipt: Receipt): Promise<IResult> {
    const snapshot = receipt.toSnapshot();

    if (snapshot.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO receipts (id, expense_id, group_id, type, size, url, attached_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        [
          snapshot._id,
          snapshot.expenseId,
          snapshot.groupId,
          snapshot.type,
          snapshot.size,
          snapshot.url,
          snapshot.attachedBy,
        ],
      );
      if (inserted.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The expense already has a receipt', {
            expenseId: snapshot.expenseId,
          }),
        );
      }
      return Result.ok();
    }

    const updated = await this.database.run(
      'UPDATE receipts SET type = ?, size = ?, url = ?, attached_by = ?, version = ? WHERE id = ? AND version = ?',
      [
        snapshot.type,
        snapshot.size,
        snapshot.url,
        snapshot.attachedBy,
        snapshot.version + 1,
        snapshot._id,
        snapshot.version,
      ],
    );
    if (updated.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The receipt changed since it was read', { id: snapshot._id }),
      );
    }
    return Result.ok();
  }
}
