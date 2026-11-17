import type { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * What the settlements of a group with one status do to each member's balance (ADR 7, ADR 8): a payer's effect is what they
 * paid (or are waiting to pay), a payee's is minus what they received (or are waiting to receive), so that a group's effects
 * add up to 0. `paid` is what Ledger counts in a balance; `pending` is what a suggestion counts as paid. Read outside a
 * transaction for a query, or on the asking command's connection inside its transaction.
 */
export class SqliteSettlementEffects {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly inCommand: boolean,
    private readonly status: 'paid' | 'pending',
  ) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  effectsOf(groupId: string): Promise<Map<string, number>> {
    const read = (connection: DatabaseSync) => {
      const rows = connection
        .prepare(
          `SELECT member_id AS memberId, SUM(effect) AS effect FROM (
             SELECT payer_id AS member_id, amount AS effect FROM settlements WHERE group_id = ? AND status = ?
             UNION ALL
             SELECT payee_id AS member_id, -amount AS effect FROM settlements WHERE group_id = ? AND status = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, this.status, groupId, this.status) as { memberId: string; effect: number }[];
      return new Map(rows.map(row => [row.memberId, Number(row.effect)]));
    };
    return this.inCommand ? Promise.resolve(read(this.database.connection)) : this.database.exclusive(read);
  }
}
