import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ReceiptView } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { IReceiptQueries } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';
import {
  RECEIPT_COLUMNS,
  ReceiptRow,
  prepareReceiptSchema,
  receiptSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/SqliteReceipts';

/** The read side of the receipts over SQLite: reads of the file, taken alone, outside any transaction (request 26). */
export class SqliteReceiptQueries implements IReceiptQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareReceiptSchema);
  }

  async findByExpense(expenseId: string): Promise<ReceiptView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE expense_id = ?`)
        .get(expenseId) as ReceiptRow | undefined;
      if (!row) return undefined;
      const { type, size, url } = receiptSnapshotOf(row);
      return { type, size, url };
    });
  }
}
