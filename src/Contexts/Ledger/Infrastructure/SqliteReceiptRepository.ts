import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt, ReceiptSnapshot } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

type Row = Omit<ReceiptSnapshot, 'expenseId' | 'groupId' | 'fileId'> & {
  expense_id: string;
  group_id: string;
  file_id: string;
};

/**
 * The receipts, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no lock of its own.
 * A save of a receipt at another version than it was read at, or of a second receipt for an expense, is a conflict, and its transaction is
 * rolled back with it.
 */
export class SqliteReceiptRepository implements IReceiptRepository {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findByExpense(expenseId: Id): Promise<Receipt | null> {
    const row = this.database.get<Row>(
      'SELECT id, expense_id, group_id, type, size, url, file_id, version FROM receipts WHERE expense_id = ?',
      expenseId.value,
    );
    if (!row) return null;
    return Receipt.fromSnapshot({
      id: row.id,
      expenseId: row.expense_id,
      groupId: row.group_id,
      type: row.type,
      size: row.size,
      url: row.url,
      fileId: row.file_id,
      version: row.version,
    });
  }

  async save(receipt: Receipt): Promise<IResult> {
    const { id, expenseId, groupId, type, size, url, fileId, version } = receipt.toSnapshot();
    if (version === 0) {
      const changed = this.database.run(
        'INSERT OR IGNORE INTO receipts (expense_id, id, group_id, type, size, url, file_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        expenseId,
        id,
        groupId,
        type,
        size,
        url,
        fileId,
      );
      if (!changed)
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The expense already has a receipt', { expenseId }),
        );
    } else {
      const changed = this.database.run(
        'UPDATE receipts SET type = ?, size = ?, url = ?, file_id = ?, version = ? WHERE expense_id = ? AND id = ? AND version = ?',
        type,
        size,
        url,
        fileId,
        version + 1,
        expenseId,
        id,
        version,
      );
      if (!changed)
        return Result.fail(new ConcurrencyConflictException('Ledger', 'The receipt has changed', { expenseId }));
    }
    return Result.ok();
  }
}
