import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';
import { RECEIPT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/receipts.schema';

/** What the screens read of the receipts, from the SQLite file, outside any transaction. */
export class SqliteReceiptQueries implements IReceiptQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(RECEIPT_STATEMENTS);
  }

  findByExpense(expenseId: string): Promise<ReceiptReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection
        .prepare('SELECT type, size, url FROM ledger_receipts WHERE expense_id = ?')
        .get(expenseId) as ReceiptReadModel | undefined;
      return row ?? null;
    });
  }
}
