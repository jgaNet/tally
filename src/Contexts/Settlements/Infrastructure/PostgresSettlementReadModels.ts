import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IPendingPayments } from '@Contexts/Settlements/Application/Ports/IPendingPayments';
import { IWaitingPaymentsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentsQueries';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import {
  CountedSettlementOf,
  ISettledAmountsQueries,
  SettledAmountOf,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { SettlementLine, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';
import { historyOfGroup, SettlementRow } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBookRepository';

/**
 * The settlements' read models, in the application's file. `findById` and `ofGroup` are read outside any transaction, so they wait
 * for the one in progress. `settledOf` counts the paid settlements, and those being refunded, which the money has not left yet (request 15): a
 * balance counts a payment once it is paid, and stops counting it once it is refunded (the storm's T11). `pendingEffectOf`
 * counts the payments waiting at the provider, which the suggestions count as paid. Neither takes a lock of its own: Ledger reads
 * `settledOf` when it reads a balance, inside a command's transaction (it holds the file already) or inside its own exclusive read.
 */
export class PostgresSettlementReadModels
  implements ISettlementQueries, ISettledAmountsQueries, IPendingPayments, IWaitingPaymentsQueries
{
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<SettlementRow>(
        `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
         FROM settlements WHERE id = ?`,
        id,
      );
      if (!row) return null;
      const history = (await historyOfGroup(this.database, row.group_id)).get(row.id) ?? [];
      return toReadModel(row, history);
    });
  }

  /** Every settlement of the group, in the order they were recorded, the earliest first, each with its history. */
  async ofGroup(groupId: string): Promise<SettlementReadModel[]> {
    return this.database.exclusive(async () => {
      const history = await historyOfGroup(this.database, groupId);
      return (
        await this.database.all<SettlementRow>(
          `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
           FROM settlements WHERE group_id = ? ORDER BY seq`,
          groupId,
        )
      ).map(row => toReadModel(row, history.get(row.id) ?? []));
    });
  }

  async settledOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.effectOf(groupId, ['paid', 'refunding']);
  }

  /**
   * The settlements a member pays or receives that the balances count (paid, or being refunded), the earliest counted first, each with
   * the instant it started to count: the first time it was paid (its history, ADR 19 and request 19), or its recording when none of its
   * history says so (a settlement stored before its history was kept). Read in the statement, outside any transaction, so it takes the
   * file's lock when it is not held already.
   */
  async countedOf(groupId: string, memberId: string): Promise<CountedSettlementOf[]> {
    return this.database.exclusive(async () => {
      const history = await historyOfGroup(this.database, groupId);
      return (
        await this.database.all<SettlementRow>(
          `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
           FROM settlements
           WHERE group_id = ? AND status IN ('paid', 'refunding') AND (payer = ? OR payee = ?)
           ORDER BY recorded_at, seq`,
          groupId,
          memberId,
          memberId,
        )
      )
        .map(row => {
          const counted = (history.get(row.id) ?? []).find(
            line => line.status === 'paid' || line.status === 'refunding',
          );
          return {
            settlementId: row.id,
            method: row.method,
            payer: row.payer,
            payee: row.payee,
            amount: row.amount,
            countedFrom: counted ? counted.at.toISOString() : row.recorded_at,
          };
        })
        .sort((a, b) => Date.parse(a.countedFrom) - Date.parse(b.countedFrom));
    });
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
      (await this.database.get<{ found: number }>(
        `SELECT 1 AS found FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding') AND (payer = ? OR payee = ?)
         LIMIT 1`,
        groupId,
        memberId,
        memberId,
      )) !== undefined
    );
  }

  /** Whether any payment in the group waits at the provider, read inside the command archiving the group (request 27). */
  async isWaitingIn(groupId: string): Promise<boolean> {
    return (
      (await this.database.get<{ found: number }>(
        `SELECT 1 AS found FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding')
         LIMIT 1`,
        groupId,
      )) !== undefined
    );
  }

  /** The change the settlements with these statuses make to each member's balance: up for a payer, down for a payee. */
  private async effectOf(groupId: string, statuses: SettlementStatus[]): Promise<SettledAmountOf[]> {
    const marks = statuses.map(() => '?').join(', ');
    return (
      await this.database.all<{ member_id: string; amount: number }>(
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
    ).map(row => ({ memberId: row.member_id, amount: row.amount }));
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
