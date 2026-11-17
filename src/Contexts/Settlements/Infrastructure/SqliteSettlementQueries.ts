import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  recorded_at: string;
}

/** What the screens read of a settlement, from the SQLite file, outside any transaction. */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        groupId: row.group_id,
        from: row.payer_id,
        to: row.payee_id,
        amount: Number(row.amount),
        method: row.method,
        status: row.status,
        at: row.recorded_at,
      };
    });
  }
}
