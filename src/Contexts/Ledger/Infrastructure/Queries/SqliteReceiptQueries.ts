import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IReceiptQueries, ReceiptView } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { createReceiptTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteReceiptRepository';

/** The read side of receipts over the application's SQLite file (request 26). */
export class SqliteReceiptQueries implements IReceiptQueries {
  constructor(private database: SqliteDatabase) {
    createReceiptTables(database);
  }

  async findByExpense(expenseId: string): Promise<ReceiptView | null> {
    const row = this.database.connection
      .prepare('SELECT type, size, url FROM receipts WHERE expense_id = ?')
      .get(expenseId) as { type: ReceiptType; size: number; url: string } | undefined;
    return row ? { type: row.type, size: row.size, url: row.url } : null;
  }
}
