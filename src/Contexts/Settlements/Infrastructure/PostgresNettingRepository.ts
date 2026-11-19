import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/** The nettings' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresNettingRepository implements INettingRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async save(netting: Netting): Promise<void> {
    const { connection } = this.database;
    const nettingId = netting._id.value;
    await connection.run(
      'INSERT INTO nettings (id, by_id, with_id, currency, amount, netted_at) VALUES (?, ?, ?, ?, ?, ?)',
      nettingId,
      netting.by.value,
      netting.other.value,
      netting.currency,
      netting.amount,
      netting.at.toISOString(),
    );
    for (const [position, settlement] of netting.settlements.entries()) {
      await connection.run(
        'INSERT INTO netting_settlements (netting_id, position, settlement_id) VALUES (?, ?, ?)',
        nettingId,
        position,
        settlement.value,
      );
    }
  }
}
