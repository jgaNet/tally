import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettledMember, SettlementView, WaitingMember } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  prepareSettlementSchema,
  SettlementRow,
  settlementView,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';

/**
 * What each member paid and received over the settlements of a group that have one of the given statuses, in one statement
 * (docs/adr/0013, docs/adr/0015).
 */
function totalsOf(
  database: SqliteDatabase,
  groupId: string,
  statuses: readonly string[],
): Array<{ memberId: string; paid: number; received: number }> {
  // One statement, so one snapshot: what each member paid and what they received, over the group's settlements of those statuses.
  const marks = statuses.map(() => '?').join(', ');
  const rows = database.connection
    .prepare(
      `SELECT member_id, SUM(paid) AS paid, SUM(received) AS received FROM (
         SELECT payer_id AS member_id, amount AS paid, 0 AS received FROM settlements WHERE group_id = ? AND status IN (${marks})
         UNION ALL
         SELECT payee_id, 0, amount FROM settlements WHERE group_id = ? AND status IN (${marks})
       ) GROUP BY member_id`,
    )
    .all(groupId, ...statuses, groupId, ...statuses) as Array<{ member_id: string; paid: number; received: number }>;
  return rows.map(row => ({ memberId: String(row.member_id), paid: Number(row.paid), received: Number(row.received) }));
}

/** The read side of the settlements over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0013, docs/adr/0014). */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async findSettlement(settlementId: string): Promise<SettlementView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(
          'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url FROM settlements WHERE id = ?',
        )
        .get(settlementId) as SettlementRow | undefined;
      return row ? settlementView(row) : undefined;
    });
  }

  /**
   * The settlements of the group that count: the paid ones, and those refunding, whose money has not gone back yet. A pending, failed or
   * refunded one is not counted (requests 13, 15).
   */
  async settledOf(groupId: string): Promise<SettledMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, ['paid', 'refunding']).map((member): SettledMember => ({ ...member })),
    );
  }

  async waitingOf(groupId: string): Promise<WaitingMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, ['pending']).map((member): WaitingMember => ({ ...member })),
    );
  }
}
