import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IWaitingPaymentRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentRoster';

/**
 * The payments waiting at the provider in SQLite (request 20, ADR 15): a settlement through the provider that is `pending` or `refunding`,
 * where the member is the payer or the payee. Reads the committed data, in the reader's snapshot, inside the write turn of the request that
 * asks, so a payment recorded before a leave is seen by it and one recorded after is refused for the leaver.
 */
export class SqliteWaitingPaymentRoster implements IWaitingPaymentRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    const row = this.database.read(db =>
      db
        .prepare(
          `SELECT 1 AS found FROM settlements
            WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding')
              AND (payer_id = ? OR payee_id = ?)
            LIMIT 1`,
        )
        .get(groupId, memberId, memberId),
    );
    return row !== undefined;
  }
}
