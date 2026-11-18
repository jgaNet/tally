import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ReceiptView } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { IReceiptQueries } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';
import {
  RECEIPT_COLUMNS,
  ReceiptRow,
  prepareReceiptSchema,
  receiptSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/PostgresReceipts';

/** The read side of the receipts over PostgreSQL: reads taken alone, outside any transaction (request 26). */
export class PostgresReceiptQueries implements IReceiptQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareReceiptSchema);
  }

  async findByExpense(expenseId: string): Promise<ReceiptView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE expense_id = ?`, [
        expenseId,
      ]);
      if (!row) return undefined;
      const { type, size, url } = receiptSnapshotOf(row);
      return { type, size, url };
    });
  }
}
