import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementRoster, SettledChange } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';

/**
 * What the committed settlements of a group do to each member's balance, in SQLite (ADR 10): a payer is moved up by what they paid,
 * a payee down by what they were paid, summed in one statement so that a settlement is counted whole or not at all.
 */
export class SqliteSettlementRoster implements ISettlementRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async settledOf(groupId: string): Promise<SettledChange[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          `SELECT member_id AS memberId, SUM(moved) AS change FROM (
             SELECT payer_id AS member_id, amount AS moved FROM settlements WHERE group_id = ?
             UNION ALL
             SELECT payee_id AS member_id, -amount AS moved FROM settlements WHERE group_id = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId),
    ) as { memberId: string; change: number }[];
    return rows.map(({ memberId, change }) => ({ memberId, change }));
  }
}
