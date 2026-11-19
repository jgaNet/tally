import { Connection, PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';
import type { SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * What the settlements of a group with the given statuses do to each member's balance (ADR 7, ADR 8, ADR 9): a payer's effect
 * is what they paid (or are waiting to pay), a payee's is minus what they received (or are waiting to receive), so that a
 * group's effects add up to 0. Ledger counts `paid` and `refunding` in a balance (a refund is not back until the provider
 * says so); a suggestion counts `pending` as paid. Read outside a transaction for a query, or on the asking command's
 * connection inside its transaction.
 */
export class PostgresSettlementEffects {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly inCommand: boolean,
    private readonly statuses: readonly SettlementStatus[],
  ) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async effectsOf(groupId: string): Promise<Map<string, number>> {
    const read = async (connection: Connection) => {
      const marks = this.statuses.map(() => '?').join(', ');
      const rows = await connection.rows<{ memberId: string; effect: number }>(
        `SELECT member_id AS "memberId", SUM(effect) AS effect FROM (
           SELECT payer_id AS member_id, COALESCE(settled, amount) AS effect FROM settlements WHERE group_id = ? AND status IN (${marks})
           UNION ALL
           SELECT payee_id AS member_id, -COALESCE(settled, amount) AS effect FROM settlements WHERE group_id = ? AND status IN (${marks})
         ) AS effects GROUP BY member_id`,
        groupId,
        ...this.statuses,
        groupId,
        ...this.statuses,
      );
      return new Map(rows.map(row => [row.memberId, Number(row.effect)]));
    };
    return this.inCommand ? read(this.database.connection) : this.database.exclusive(read);
  }
}
