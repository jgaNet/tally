import type { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';
import type { SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * What the settlements of a group with the given statuses do to each member's balance (ADR 7, ADR 8, ADR 9): a payer's effect
 * is what they paid (or are waiting to pay), a payee's is minus what they received (or are waiting to receive), so that a
 * group's effects add up to 0. Ledger counts `paid` and `refunding` in a balance (a refund is not back until the provider
 * says so); a suggestion counts `pending` as paid. Read outside a transaction for a query, or on the asking command's
 * connection inside its transaction.
 */
export class SqliteSettlementEffects {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly inCommand: boolean,
    private readonly statuses: readonly SettlementStatus[],
  ) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  effectsOf(groupId: string): Promise<Map<string, number>> {
    const read = (connection: DatabaseSync) => {
      const marks = this.statuses.map(() => '?').join(', ');
      const rows = connection
        .prepare(
          `SELECT member_id AS memberId, SUM(effect) AS effect FROM (
             SELECT payer_id AS member_id, amount AS effect FROM settlements WHERE group_id = ? AND status IN (${marks})
             UNION ALL
             SELECT payee_id AS member_id, -amount AS effect FROM settlements WHERE group_id = ? AND status IN (${marks})
           ) GROUP BY member_id`,
        )
        .all(groupId, ...this.statuses, groupId, ...this.statuses) as { memberId: string; effect: number }[];
      return new Map(rows.map(row => [row.memberId, Number(row.effect)]));
    };
    return this.inCommand ? Promise.resolve(read(this.database.connection)) : this.database.exclusive(read);
  }
}
