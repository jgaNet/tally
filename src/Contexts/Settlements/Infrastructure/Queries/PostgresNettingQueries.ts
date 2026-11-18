import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { createNettingTables } from '@Contexts/Settlements/Infrastructure/Repositories/PostgresNettingRepository';
import { INettingQueries, NettingView } from '@Contexts/Settlements/Domain/Netting/Ports/INettingQueries';

interface NettingRow {
  id: string;
  by_account: string;
  with_account: string;
  currency: string;
  amount: number;
}

/** The nettings read model over the application's database: each netting with its settlements in the order they were made. */
export class PostgresNettingQueries implements INettingQueries {
  constructor(private database: PostgresDatabase) {
    createNettingTables(database);
  }

  async findById(id: string): Promise<NettingView | null> {
    const row = await this.database.get<NettingRow>('SELECT * FROM nettings WHERE id = ?', [id]);
    if (!row) return null;

    const settlements = await this.database.all<{ settlement_id: string }>(
      'SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY seq',
      [id],
    );
    return {
      id: row.id,
      by: row.by_account,
      with: row.with_account,
      currency: row.currency,
      amount: row.amount,
      settlements: settlements.map(({ settlement_id }) => settlement_id),
    };
  }
}
