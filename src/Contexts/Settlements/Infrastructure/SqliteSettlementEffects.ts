import type { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * What the recorded settlements of a group do to each member's balance (ADR 7): a payer's effect is what they paid, a
 * payee's is minus what they received, so that a group's effects add up to 0. Read outside a transaction for a query, or
 * on the asking command's connection inside its transaction.
 */
export class SqliteSettlementEffects implements ISettlementEffects {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly inCommand: boolean,
  ) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  effectsOf(groupId: string): Promise<Map<string, number>> {
    const read = (connection: DatabaseSync) => {
      const rows = connection
        .prepare(
          `SELECT member_id AS memberId, SUM(effect) AS effect FROM (
             SELECT payer_id AS member_id, amount AS effect FROM settlements WHERE group_id = ?
             UNION ALL
             SELECT payee_id AS member_id, -amount AS effect FROM settlements WHERE group_id = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId) as { memberId: string; effect: number }[];
      return new Map(rows.map(row => [row.memberId, Number(row.effect)]));
    };
    return this.inCommand ? Promise.resolve(read(this.database.connection)) : this.database.exclusive(read);
  }
}
