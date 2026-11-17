import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  createSettlementTables,
  SettlementRow,
} from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import {
  ISettlementQueries,
  PaidSettlement,
  SettlementView,
  WaitingSettlement,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/** The settlements read model over the application's file: each settlement as it stands, read in the order recorded. */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private database: SqliteDatabase) {
    createSettlementTables(database);
  }

  findById(id: string): Promise<SettlementView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
      if (!row) return null;
      const view: SettlementView = {
        id: row.id,
        groupId: row.group_id,
        from: row.payer,
        to: row.payee,
        amount: row.amount,
        method: row.method,
        status: row.status,
        at: row.at,
      };
      if (row.method === 'provider' && row.pay_url) view.payUrl = row.pay_url;
      return view;
    });
  }

  paidIn(groupId: string): Promise<PaidSettlement[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          "SELECT payer, payee, amount FROM settlements WHERE group_id = ? AND status IN ('paid', 'refunding') ORDER BY recorded_seq",
        )
        .all(groupId) as unknown as { payer: string; payee: string; amount: number }[];
      return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
    });
  }

  waitingIn(groupId: string): Promise<WaitingSettlement[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          "SELECT payer, payee, amount FROM settlements WHERE group_id = ? AND method = 'provider' AND status = 'pending' ORDER BY recorded_seq",
        )
        .all(groupId) as unknown as { payer: string; payee: string; amount: number }[];
      return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
    });
  }
}
