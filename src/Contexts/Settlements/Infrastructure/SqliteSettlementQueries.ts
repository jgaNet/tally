import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettledMember, SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  prepareSettlementSchema,
  SettlementRow,
  settlementView,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';

/** The read side of the settlements over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0013). */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async findSettlement(settlementId: string): Promise<SettlementView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(
          'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at FROM settlements WHERE id = ?',
        )
        .get(settlementId) as SettlementRow | undefined;
      return row ? settlementView(row) : undefined;
    });
  }

  async settledOf(groupId: string): Promise<SettledMember[]> {
    // One statement, so one snapshot: what each member paid and what they received, over the group's settlements (docs/adr/0013).
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT member_id, SUM(paid) AS paid, SUM(received) AS received FROM (
             SELECT payer_id AS member_id, amount AS paid, 0 AS received FROM settlements WHERE group_id = ?
             UNION ALL
             SELECT payee_id, 0, amount FROM settlements WHERE group_id = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId) as Array<{ member_id: string; paid: number; received: number }>;
      return rows.map((row): SettledMember => ({
        memberId: String(row.member_id),
        paid: Number(row.paid),
        received: Number(row.received),
      }));
    });
  }
}
