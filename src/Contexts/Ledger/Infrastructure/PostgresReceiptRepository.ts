import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
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

/** The receipts' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresReceiptRepository implements IReceiptRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(RECEIPT_STATEMENTS);
  }

  async findByExpense(expenseId: Id): Promise<Receipt | null> {
    const row = await this.database.connection.row<ReceiptRow>(
      'SELECT id, expense_id, type, size, stored_id, url, attached_at, version FROM ledger_receipts WHERE expense_id = ?',
      expenseId.value,
    );
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
      const { changes } = await connection.run(
        `INSERT INTO ledger_receipts (id, expense_id, type, size, stored_id, url, attached_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (expense_id) DO NOTHING`,
        id,
        expenseId,
        type,
        size,
        storedId,
        url,
        attachedAt,
      );
      if (changes === 0) return conflict();
    } else {
      const { changes } = await connection.run(
        `UPDATE ledger_receipts SET type = ?, size = ?, stored_id = ?, url = ?, attached_at = ?, version = version + 1
          WHERE id = ? AND version = ?`,
        type,
        size,
        storedId,
        url,
        attachedAt,
        id,
        version,
      );
      if (changes === 0) return conflict();
    }
    return Result.ok();
  }
}
