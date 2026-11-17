import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

interface PayoutAccountRow {
  id: string;
  owner_id: string;
  account_id: string;
  version: number;
}

/** The payout accounts' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqlitePayoutAccountRepository implements IPayoutAccountRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByOwner(owner: Id): Promise<PayoutAccount | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM payout_accounts WHERE owner_id = ?')
      .get(owner.value) as PayoutAccountRow | undefined;
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
    try {
      if (account.version === 0) {
        connection
          .prepare('INSERT INTO payout_accounts (id, owner_id, account_id, version) VALUES (?, ?, ?, 1)')
          .run(id, account.owner.value, account.accountId);
      } else {
        const { changes } = connection
          .prepare('UPDATE payout_accounts SET account_id = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(account.accountId, id, account.version);
        if (changes === 0) return conflict();
      }
    } catch (error) {
      // A second account made at once for the same person: the one the person has is the one that stands.
      if (error instanceof Error && /UNIQUE constraint failed: payout_accounts.owner_id/.test(error.message)) {
        return conflict();
      }
      throw error;
    }
    return Result.ok();
  }
}
