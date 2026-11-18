import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';
import { RECEIPT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/receipts.schema';

/** What the screens read of the receipts, from the PostgreSQL database, outside any transaction. */
export class PostgresReceiptQueries implements IReceiptQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(RECEIPT_STATEMENTS);
  }

  findByExpense(expenseId: string): Promise<ReceiptReadModel | null> {
    return this.database.exclusive(async connection => {
      const row = await connection.row<ReceiptReadModel>(
        'SELECT type, size, url FROM ledger_receipts WHERE expense_id = ?',
        expenseId,
      );
      return row ?? null;
    });
  }
}
