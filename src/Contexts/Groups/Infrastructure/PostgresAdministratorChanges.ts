import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareAccountsSchema } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';
import { AdministratorChange } from '@Contexts/Groups/Domain/Account/DTOs';
import { IAdministratorChanges } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorChanges';

type ChangeRow = { id: string; at: string; by_id: string; action: string; subject_id: string };

/** Groups' administrators' log of account changes, over PostgreSQL: one read, the oldest first (request 34, docs/adr/0034). */
export class PostgresAdministratorChanges implements IAdministratorChanges {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareAccountsSchema);
  }

  async changesOf(): Promise<AdministratorChange[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<ChangeRow>(
        'SELECT id, at, by_id, action, subject_id FROM administrator_account_changes ORDER BY seq',
        [],
      );
      return rows.map(row => ({
        id: String(row.id),
        at: String(row.at),
        by: String(row.by_id),
        action: row.action === 'suspended' ? 'suspended' : 'reinstated',
        subjectId: String(row.subject_id),
      }));
    });
  }
}
