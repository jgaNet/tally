import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

/** The receipts' read model, read outside any transaction: it waits for the one in progress, as the other read models of Ledger do. */
export class SqliteReceiptReadModels implements IReceiptQueries {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findByExpense(expenseId: string): Promise<ReceiptReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<{ type: ReceiptType; size: number; url: string }>(
        'SELECT type, size, url FROM receipts WHERE expense_id = ?',
        expenseId,
      );
      return row ? { type: row.type, size: row.size, url: row.url } : null;
    });
  }
}
