import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IWaitingPaymentRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentRoster';

/**
 * The payments waiting at the provider in PostgreSQL (request 20, ADR 15): a settlement through the provider that is `pending`, `refunding` or `contested` (request 33),
 * where the member is the payer or the payee. Reads the committed data, in the reader's snapshot, inside the write turn of the request that
 * asks, so a payment recorded before a leave is seen by it and one recorded after is refused for the leaver.
 */
export class PostgresWaitingPaymentRoster implements IWaitingPaymentRoster {
  constructor(private readonly database: PostgresDatabase) {}

  async hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    const row = await this.database.read(db =>
      db
        .prepare(
          `SELECT 1 AS found FROM settlements
            WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding', 'contested')
              AND (payer_id = ? OR payee_id = ?)
            LIMIT 1`,
        )
        .get(groupId, memberId, memberId),
    );
    return row !== undefined;
  }

  /** Whether the account pays or receives a payment through the provider that waits, in any group (feature 35, request 35). */
  async hasPaymentWaitingOf(accountId: string): Promise<boolean> {
    const row = await this.database.read(db =>
      db
        .prepare(
          `SELECT 1 AS found FROM settlements
            WHERE method = 'provider' AND status IN ('pending', 'refunding', 'contested')
              AND (payer_id = ? OR payee_id = ?)
            LIMIT 1`,
        )
        .get(accountId, accountId),
    );
    return row !== undefined;
  }
}
