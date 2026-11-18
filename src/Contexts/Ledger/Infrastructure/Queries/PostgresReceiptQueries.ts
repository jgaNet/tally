import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IReceiptQueries, ReceiptView } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { defineReceiptTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresReceiptRepository';

/** The read side of receipts over the application's PostgreSQL database (request 26). */
export class PostgresReceiptQueries implements IReceiptQueries {
  constructor(private database: PostgresDatabase) {
    defineReceiptTables(database);
  }

  async findByExpense(expenseId: string): Promise<ReceiptView | null> {
    const row = await this.database.get<{ type: ReceiptType; size: number; url: string }>(
      'SELECT type, size, url FROM receipts WHERE expense_id = ?',
      [expenseId],
    );
    return row ? { type: row.type, size: row.size, url: row.url } : null;
  }
}
