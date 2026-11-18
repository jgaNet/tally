import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { AdministratorDecision } from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';
import { IGroupAdministratorLog } from '@Contexts/Groups/Application/Ports/IGroupAdministratorLog';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  at: string;
  by_account: string;
  action: AdministratorDecision['action'];
  subject_id: string;
}

/**
 * Groups' entries of the administrators' log, in the application's file (request 34). `record` writes inside the command's transaction,
 * which holds the file, so it takes no lock; `entries` waits for the transaction in progress, as the other reads do.
 */
export class PostgresAdministratorLog implements IGroupAdministratorLog {
  constructor(private database: PostgresDatabase) {
    createGroupsTables(database);
  }

  async record(entry: AdministratorDecision): Promise<void> {
    await this.database.run(
      'INSERT INTO administrator_log_entries (id, at, by_account, action, subject_id) VALUES (?, ?, ?, ?, ?)',
      entry.id,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
    );
  }

  async entries(): Promise<AdministratorDecision[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<Row>(
          'SELECT id, at, by_account, action, subject_id FROM administrator_log_entries ORDER BY at, seq',
        )
      ).map(row => ({
        id: row.id,
        at: row.at,
        by: row.by_account,
        action: row.action,
        subjectId: row.subject_id,
      })),
    );
  }
}
