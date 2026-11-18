import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

interface PayoutAccountRow {
  id: string;
  owner_id: string;
  account_id: string;
  version: number;
}

/** The payout accounts' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresPayoutAccountRepository implements IPayoutAccountRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByOwner(owner: Id): Promise<PayoutAccount | null> {
    const row = await this.database.connection.row<PayoutAccountRow>(
      'SELECT * FROM payout_accounts WHERE owner_id = ?',
      owner.value,
    );
    return row
      ? PayoutAccount.fromSnapshot({
          id: row.id,
          owner: row.owner_id,
          accountId: row.account_id,
          version: Number(row.version),
        })
      : null;
  }

  async save(account: PayoutAccount): Promise<IResult> {
    const { connection } = this.database;
    const id = account._id.value;
    const conflict = () =>
      Result.fail(
        new ConcurrencyConflictException('Settlements', 'The payout account changed since it was read', { id }),
      );
    if (account.version === 0) {
      // A second account made at once for the same person: the one the person has is the one that stands. It is not
      // written (ON CONFLICT DO NOTHING), so that the transaction is not aborted by a refused statement.
      const { changes } = await connection.run(
        'INSERT INTO payout_accounts (id, owner_id, account_id, version) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING',
        id,
        account.owner.value,
        account.accountId,
      );
      if (changes === 0) return conflict();
    } else {
      const { changes } = await connection.run(
        'UPDATE payout_accounts SET account_id = ?, version = version + 1 WHERE id = ? AND version = ?',
        account.accountId,
        id,
        account.version,
      );
      if (changes === 0) return conflict();
    }
    return Result.ok();
  }
}
