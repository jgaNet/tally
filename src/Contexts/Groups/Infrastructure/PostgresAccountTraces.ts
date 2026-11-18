import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAccountTraces } from '@Contexts/Groups/Application/Ports/IAccountTraces';
import { DELETED_ACCOUNT_NAME } from '@Contexts/Groups/Domain/Account/Account';

interface Row {
  id: string;
  payload: string;
}

/**
 * Erases an account's name and email from the facts its sign-up left in the outbox, and the operations it started from their subject: the event that announced it (`AccountRegistered`, which
 * carries the name) and the command that asked for it (`SignUp`, which carries the email, the password and the name). It runs inside the
 * deletion's transaction, so it takes no lock of its own.
 */
export class PostgresAccountTraces implements IAccountTraces {
  constructor(private database: PostgresDatabase) {}

  async erase({ accountId, email }: { accountId: string; email: string | null }): Promise<void> {
    const announced = await this.database.all<Row>(`SELECT id, payload FROM outbox WHERE name = 'AccountRegistered'`);
    for (const row of announced) {
      const payload = JSON.parse(row.payload) as { accountId?: string };
      if (payload.accountId !== accountId) continue;
      await this.database.run(
        'UPDATE outbox SET payload = ? WHERE id = ?',
        JSON.stringify({ ...payload, name: DELETED_ACCOUNT_NAME }),
        row.id,
      );
    }
    // The operations the person started are theirs no more: whoever holds an operation's id follows it, as for a sign-up's (ADR 27), which is
    // how the person follows the deletion itself once their token proves nothing.
    await this.database.run('UPDATE operation_records SET subject_id = NULL WHERE subject_id = ?', accountId);
    if (email === null) return;
    const asked = await this.database.all<Row>(
      `SELECT id, payload FROM outbox WHERE kind = 'command' AND name = 'SignUp'`,
    );
    for (const row of asked) {
      const payload = JSON.parse(row.payload) as { email?: string };
      if (payload.email?.trim().toLowerCase() !== email) continue;
      await this.database.run(
        'UPDATE outbox SET payload = ? WHERE id = ?',
        JSON.stringify({ email: '', password: '', name: '' }),
        row.id,
      );
    }
  }
}
