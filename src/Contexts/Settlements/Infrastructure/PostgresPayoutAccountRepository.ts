import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface PayoutAccountRow {
  id: string;
  owner: string;
  account_id: string;
  version: number;
}

/**
 * The payout accounts, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no
 * lock of its own. A person has one row, unique by owner, so that two first settings at once cannot both win: the second is a
 * conflict, and the command reads and decides again.
 */
export class PostgresPayoutAccountRepository implements IPayoutAccountRepository {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async findByOwner(owner: Id): Promise<PayoutAccount | null> {
    const row = await this.database.get<PayoutAccountRow>(
      'SELECT id, owner, account_id, version FROM payout_accounts WHERE owner = ?',
      owner.value,
    );
    return row ? this.toAccount(row) : null;
  }

  async save(account: PayoutAccount): Promise<IResult> {
    const owner = account.owner.value;
    const accountId = account.accountId as string;
    if (account.version === 0) {
      const opened = await this.database.run(
        'INSERT INTO payout_accounts (id, owner, account_id, version) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING',
        account._id.value,
        owner,
        accountId,
      );
      if (!opened) return conflict(owner);
    } else {
      const changed = await this.database.run(
        'UPDATE payout_accounts SET account_id = ?, version = ? WHERE id = ? AND version = ?',
        accountId,
        account.version + 1,
        account._id.value,
        account.version,
      );
      if (!changed) return conflict(owner);
    }
    return Result.ok();
  }

  private toAccount(row: PayoutAccountRow): PayoutAccount {
    return PayoutAccount.fromSnapshot({
      id: row.id,
      owner: row.owner,
      accountId: row.account_id,
      version: row.version,
    });
  }
}

const conflict = (owner: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Settlements', 'The payout account has changed', { owner }));
