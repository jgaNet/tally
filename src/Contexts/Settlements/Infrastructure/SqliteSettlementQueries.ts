import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettledMember, SettlementView, WaitingMember } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  prepareSettlementSchema,
  SettlementRow,
  settlementView,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';

/** What each member paid and received over the settlements of a group that have the given status, in one statement (docs/adr/0013). */
function totalsOf(
  database: SqliteDatabase,
  groupId: string,
  status: 'paid' | 'pending',
): Array<{ memberId: string; paid: number; received: number }> {
  // One statement, so one snapshot: what each member paid and what they received, over the group's settlements of that status.
  const rows = database.connection
    .prepare(
      `SELECT member_id, SUM(paid) AS paid, SUM(received) AS received FROM (
         SELECT payer_id AS member_id, amount AS paid, 0 AS received FROM settlements WHERE group_id = ? AND status = ?
         UNION ALL
         SELECT payee_id, 0, amount FROM settlements WHERE group_id = ? AND status = ?
       ) GROUP BY member_id`,
    )
    .all(groupId, status, groupId, status) as Array<{ member_id: string; paid: number; received: number }>;
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

  /** The settlements of the group that are paid: a pending or a failed one is not counted (request 13). */
  async settledOf(groupId: string): Promise<SettledMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, 'paid').map((member): SettledMember => ({ ...member })),
    );
  }

  async waitingOf(groupId: string): Promise<WaitingMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, 'pending').map((member): WaitingMember => ({ ...member })),
    );
  }
}
