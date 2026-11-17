import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { createSettlementTables } from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import {
  ISettlementQueries,
  PaidSettlement,
  SettlementView,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

interface SettlementRow {
  id: string;
  group_id: string;
  payer: string;
  payee: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  at: string;
}

/** The settlements read model over the application's file: each settlement as it was recorded, read in the order recorded. */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private database: SqliteDatabase) {
    createSettlementTables(database);
  }

  findById(id: string): Promise<SettlementView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
      return row
        ? {
            id: row.id,
            groupId: row.group_id,
            from: row.payer,
            to: row.payee,
            amount: row.amount,
            method: row.method,
            status: row.status,
            at: row.at,
          }
        : null;
    });
  }

  paidIn(groupId: string): Promise<PaidSettlement[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT payer, payee, amount FROM settlements WHERE group_id = ? ORDER BY recorded_seq')
        .all(groupId) as unknown as { payer: string; payee: string; amount: number }[];
      return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
    });
  }
}
