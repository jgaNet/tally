import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementRoster, SettledChange } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';
import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';

/**
 * What the paid settlements of a group do to each member's balance, in SQLite (ADR 10): a payer is moved up by what they paid, a payee
 * down by what they were paid, summed in one statement so that a settlement is counted whole or not at all. Only a settlement that is
 * `paid` counts, and so does a `refunding` one (the money has not gone back yet): a payment waiting at the provider is not in the balances
 * until the provider says it succeeded (feature 13), and a `refunded` one is not counted at all (feature 15).
 */
export class SqliteSettlementRoster implements ISettlementRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async settledOf(groupId: string): Promise<SettledChange[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          `SELECT member_id AS memberId, SUM(moved) AS change FROM (
             SELECT payer_id AS member_id, amount AS moved FROM settlements WHERE group_id = ? AND status IN ('paid', 'refunding')
             UNION ALL
             SELECT payee_id AS member_id, -amount AS moved FROM settlements WHERE group_id = ? AND status IN ('paid', 'refunding')
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId),
    ) as { memberId: string; change: number }[];
    return rows.map(({ memberId, change }) => ({ memberId, change }));
  }

  async auditOf(groupId: string): Promise<SettlementAuditEntry[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          `SELECT id, group_id, at, by_account_id, action, subject_id, amount FROM settlement_audit
           WHERE group_id = ? ORDER BY at, seq`,
        )
        .all(groupId),
    ) as {
      id: string;
      group_id: string;
      at: string;
      by_account_id: string;
      action: SettlementAuditEntry['action'];
      subject_id: string;
      amount: number;
    }[];
    return rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      at: row.at,
      by: row.by_account_id,
      action: row.action,
      subjectId: row.subject_id,
      amount: row.amount,
    }));
  }
}
