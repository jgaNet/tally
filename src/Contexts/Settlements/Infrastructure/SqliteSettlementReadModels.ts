import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IPendingPayments } from '@Contexts/Settlements/Application/Ports/IPendingPayments';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import {
  ISettledAmountsQueries,
  SettledAmountOf,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';
import { SettlementRow } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';

/**
 * The settlements' read models, in the application's file. `findById` is read outside any transaction, so it waits for the one in
 * progress. `settledOf` counts the paid settlements only: a balance counts a payment once it is paid (the storm's T11). `pendingEffectOf`
 * counts the payments waiting at the provider, which the suggestions count as paid. Neither takes a lock of its own: Ledger reads
 * `settledOf` when it reads a balance, inside a command's transaction (it holds the file already) or inside its own exclusive read.
 */
export class SqliteSettlementReadModels implements ISettlementQueries, ISettledAmountsQueries, IPendingPayments {
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
      return row ? toReadModel(row) : null;
    });
  }

  async settledOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.effectOf(groupId, 'paid');
  }

  async pendingEffectOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.effectOf(groupId, 'pending');
  }

  /** The change the settlements with this status make to each member's balance: up for a payer, down for a payee. */
  private effectOf(groupId: string, status: SettlementStatus): SettledAmountOf[] {
    return this.database
      .all<{ member_id: string; amount: number }>(
        `SELECT member_id, SUM(delta) AS amount FROM (
           SELECT payer AS member_id, amount AS delta FROM settlements WHERE group_id = ? AND status = ?
           UNION ALL
           SELECT payee AS member_id, -amount AS delta FROM settlements WHERE group_id = ? AND status = ?
         ) GROUP BY member_id`,
        groupId,
        status,
        groupId,
        status,
      )
      .map(row => ({ memberId: row.member_id, amount: row.amount }));
  }
}

const toReadModel = (row: SettlementRow): SettlementReadModel => ({
  id: row.id,
  groupId: row.group_id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  method: row.method,
  status: row.status,
  at: row.recorded_at,
  ...(row.pay_url ? { payUrl: row.pay_url } : {}),
});
