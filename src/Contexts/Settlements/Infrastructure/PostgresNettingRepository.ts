import { IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

/**
 * The nettings, in the application's database, in the transaction of the netting's command: the netting and its settlements' ids are
 * stored together, or not at all, with the settlements of its books (request 32). A netting is written once and never changed.
 */
export class PostgresNettingRepository implements INettingRepository {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async save(netting: Netting): Promise<IResult> {
    await this.database.run(
      'INSERT INTO nettings (id, by_account, with_account, currency, amount) VALUES (?, ?, ?, ?, ?)',
      netting._id.value,
      netting.by.value,
      netting.withAccount.value,
      netting.currency,
      netting.amount,
    );
    for (const [index, settlementId] of netting.settlementIds.entries()) {
      await this.database.run(
        'INSERT INTO netting_settlements (netting_id, position, settlement_id) VALUES (?, ?, ?)',
        netting._id.value,
        index + 1,
        settlementId.value,
      );
    }
    return Result.ok();
  }
}
