import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INettingQueries } from '@Contexts/Settlements/Application/Ports/INettingQueries';
import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface NettingRow {
  id: string;
  by_account: string;
  with_account: string;
  currency: string;
  amount: number;
}

/** The nettings' read model, in the application's file: read outside any transaction, so it waits for the one in progress (as the settlements' do). */
export class PostgresNettingReadModels implements INettingQueries {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async findById(id: string): Promise<NettingReadModel | null> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<NettingRow>(
        'SELECT id, by_account, with_account, currency, amount FROM nettings WHERE id = ?',
        id,
      );
      if (!row) return null;
      const settlements = await this.database.all<{ settlement_id: string }>(
        'SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY position',
        id,
      );
      return {
        id: row.id,
        by: row.by_account,
        with: row.with_account,
        currency: row.currency,
        amount: row.amount,
        settlements: settlements.map(settlement => settlement.settlement_id),
      };
    });
  }
}
