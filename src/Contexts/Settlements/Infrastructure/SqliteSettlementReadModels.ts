import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import {
  ISettledAmountsQueries,
  SettledAmountOf,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface Row {
  id: string;
  group_id: string;
  payer: string;
  payee: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  recorded_at: string;
}

/**
 * The settlements' read models, in the application's file. `findById` is read outside any transaction, so it waits for the one in
 * progress. `settledOf` takes no lock of its own: Ledger reads it when it reads a balance, which it does inside a command's
 * transaction (it holds the file already) or inside its own exclusive read.
 */
export class SqliteSettlementReadModels implements ISettlementQueries, ISettledAmountsQueries {
  constructor(private database: SqliteDatabase) {
    createSettlementsTables(database);
  }

  async findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<Row>(
        'SELECT id, group_id, payer, payee, amount, method, status, recorded_at FROM settlements WHERE id = ?',
        id,
      );
      return row ? toReadModel(row) : null;
    });
  }

  async settledOf(groupId: string): Promise<SettledAmountOf[]> {
    return this.database
      .all<{ member_id: string; amount: number }>(
        `SELECT member_id, SUM(delta) AS amount FROM (
           SELECT payer AS member_id, amount AS delta FROM settlements WHERE group_id = ?
           UNION ALL
           SELECT payee AS member_id, -amount AS delta FROM settlements WHERE group_id = ?
         ) GROUP BY member_id`,
        groupId,
        groupId,
      )
      .map(row => ({ memberId: row.member_id, amount: row.amount }));
  }
}

const toReadModel = (row: Row): SettlementReadModel => ({
  id: row.id,
  groupId: row.group_id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  method: row.method,
  status: row.status,
  at: row.recorded_at,
});
