import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IPendingPayments } from '@Contexts/Settlements/Application/Ports/IPendingPayments';
import { IWaitingPaymentsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentsQueries';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import {
  ISettledAmountsQueries,
  SettledAmountOf,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { SettlementLine, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';
import { historyOfGroup, SettlementRow } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';

/**
 * The settlements' read models, in the application's file. `findById` and `ofGroup` are read outside any transaction, so they wait
 * for the one in progress. `settledOf` counts the paid settlements, and those being refunded, which the money has not left yet (request 15): a
 * balance counts a payment once it is paid, and stops counting it once it is refunded (the storm's T11). `pendingEffectOf`
 * counts the payments waiting at the provider, which the suggestions count as paid. Neither takes a lock of its own: Ledger reads
 * `settledOf` when it reads a balance, inside a command's transaction (it holds the file already) or inside its own exclusive read.
 */
export class SqliteSettlementReadModels
  implements ISettlementQueries, ISettledAmountsQueries, IPendingPayments, IWaitingPaymentsQueries
{
  constructor(private database: SqliteDatabase) {
    createSettlementsTables(database);
  }

  async findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<SettlementRow>(
        `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
         FROM settlements WHERE id = ?`,
        id,
      );
      if (!row) return null;
      const history = historyOfGroup(this.database, row.group_id).get(row.id) ?? [];
      return toReadModel(row, history);
    });
  }

  /** Every settlement of the group, in the order they were recorded, the earliest first, each with its history. */
  async ofGroup(groupId: string): Promise<SettlementReadModel[]> {
    return this.database.exclusive(() => {
      const history = historyOfGroup(this.database, groupId);
      return this.database
        .all<SettlementRow>(
          `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
           FROM settlements WHERE group_id = ? ORDER BY rowid`,
          groupId,
        )
        .map(row => toReadModel(row, history.get(row.id) ?? []));
    });
  }

  async settledOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.effectOf(groupId, ['paid', 'refunding']);
  }

  async pendingEffectOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.effectOf(groupId, ['pending']);
  }

  /**
   * Whether a payment through the provider that the member pays or receives in the group is waiting: pending, or being refunded
   * (requests 13 and 15). Read inside the leave's transaction, which holds the file already, so it takes no lock.
   */
  async isWaitingFor(groupId: string, memberId: string): Promise<boolean> {
    return (
      this.database.get<{ found: number }>(
        `SELECT 1 AS found FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding') AND (payer = ? OR payee = ?)
         LIMIT 1`,
        groupId,
        memberId,
        memberId,
      ) !== undefined
    );
  }

  /** The change the settlements with these statuses make to each member's balance: up for a payer, down for a payee. */
  private effectOf(groupId: string, statuses: SettlementStatus[]): SettledAmountOf[] {
    const marks = statuses.map(() => '?').join(', ');
    return this.database
      .all<{ member_id: string; amount: number }>(
        `SELECT member_id, SUM(delta) AS amount FROM (
           SELECT payer AS member_id, amount AS delta FROM settlements WHERE group_id = ? AND status IN (${marks})
           UNION ALL
           SELECT payee AS member_id, -amount AS delta FROM settlements WHERE group_id = ? AND status IN (${marks})
         ) GROUP BY member_id`,
        groupId,
        ...statuses,
        groupId,
        ...statuses,
      )
      .map(row => ({ memberId: row.member_id, amount: row.amount }));
  }
}

const toReadModel = (row: SettlementRow, history: readonly SettlementLine[]): SettlementReadModel => ({
  id: row.id,
  groupId: row.group_id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  method: row.method,
  status: row.status,
  at: row.recorded_at,
  ...(row.pay_url ? { payUrl: row.pay_url } : {}),
  history: history.map(line => ({ status: line.status, at: line.at.toISOString() })),
});
