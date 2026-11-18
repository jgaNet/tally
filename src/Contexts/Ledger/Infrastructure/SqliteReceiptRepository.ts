import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt, ReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { RECEIPT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/receipts.schema';

interface ReceiptRow {
  id: string;
  expense_id: string;
  type: ReceiptSnapshot['type'];
  size: number;
  stored_id: string;
  url: string;
  attached_at: string;
  version: number;
}

/** The receipts' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteReceiptRepository implements IReceiptRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(RECEIPT_STATEMENTS);
  }

  async findByExpense(expenseId: Id): Promise<Receipt | null> {
    const row = this.database.connection
      .prepare(
        'SELECT id, expense_id, type, size, stored_id, url, attached_at, version FROM ledger_receipts WHERE expense_id = ?',
      )
      .get(expenseId.value) as ReceiptRow | undefined;
    if (!row) return null;
    return Receipt.fromSnapshot({
      id: row.id,
      expenseId: row.expense_id,
      type: row.type,
      size: row.size,
      storedId: row.stored_id,
      url: row.url,
      attachedAt: row.attached_at,
      version: row.version,
    });
  }

  async save(receipt: Receipt): Promise<IResult> {
    const { id, expenseId, type, size, storedId, url, attachedAt, version } = receipt.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(
        new ConcurrencyConflictException('Ledger', 'The receipt of the expense changed since it was read', { id }),
      );

    if (version === 0) {
      const { changes } = connection
        .prepare(
          `INSERT INTO ledger_receipts (id, expense_id, type, size, stored_id, url, attached_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (expense_id) DO NOTHING`,
        )
        .run(id, expenseId, type, size, storedId, url, attachedAt);
      if (changes === 0) return conflict();
    } else {
      const { changes } = connection
        .prepare(
          `UPDATE ledger_receipts SET type = ?, size = ?, stored_id = ?, url = ?, attached_at = ?, version = version + 1
            WHERE id = ? AND version = ?`,
        )
        .run(type, size, storedId, url, attachedAt, id, version);
      if (changes === 0) return conflict();
    }
    return Result.ok();
  }
}
