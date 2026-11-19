import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { INettingQueries } from '@Contexts/Settlements/Application/Ports/INettingQueries';
import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

interface NettingRow {
  id: string;
  by_id: string;
  with_id: string;
  currency: string;
  amount: number;
}

/** What the two people read of a netting, from the PostgreSQL database, outside any transaction (request 32). */
export class PostgresNettingQueries implements INettingQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  findById(id: string): Promise<NettingReadModel | null> {
    return this.database.exclusive(async connection => {
      const row = await connection.row<NettingRow>('SELECT * FROM nettings WHERE id = ?', id);
      if (!row) return null;
      const settlements = await connection.rows<{ settlement_id: string }>(
        'SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY position',
        id,
      );
      return {
        id: row.id,
        by: row.by_id,
        with: row.with_id,
        currency: row.currency,
        amount: Number(row.amount),
        settlements: settlements.map(settlement => settlement.settlement_id),
      };
    });
  }
}
