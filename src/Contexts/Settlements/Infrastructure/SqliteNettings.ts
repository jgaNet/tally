import { INettings } from '@Contexts/Settlements/Application/INettings';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

import { SettlementsDatabase } from './SettlementsDatabase';

/**
 * The nettings in PostgreSQL: the store `NetDebts` saves a netting to, in the same transaction as the settlements it made (request 32). A
 * netting is written once and never changed, so this only inserts it and its settlements in the order they were made; the read side is
 * `SqliteSettlements.nettingOf`.
 */
export class SqliteNettings implements INettings {
  constructor(private readonly database: SettlementsDatabase) {}

  async save(netting: Netting): Promise<void> {
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO nettings (id, asked_by, asked_with, currency, amount) VALUES ($1, $2, $3, $4, $5)',
        [netting.nettingId, netting.by, netting.with, netting.currency, netting.amount],
      );
      for (const settlementId of netting.settlements) {
        await this.database.execute('INSERT INTO netting_settlements (netting_id, settlement_id) VALUES ($1, $2)', [
          netting.nettingId,
          settlementId,
        ]);
      }
    });
  }
}
