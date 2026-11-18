import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

/** The receipts' read model, read outside any transaction: it waits for the one in progress, as the other read models of Ledger do. */
export class PostgresReceiptReadModels implements IReceiptQueries {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async findByExpense(expenseId: string): Promise<ReceiptReadModel | null> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ type: ReceiptType; size: number; url: string }>(
        'SELECT type, size, url FROM receipts WHERE expense_id = ?',
        expenseId,
      );
      return row ? { type: row.type, size: row.size, url: row.url } : null;
    });
  }
}
