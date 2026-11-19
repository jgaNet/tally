import { AdministratorLogEntry } from '@Contexts/Groups/Domain/Account/AdministratorLogEntry';
import { IAdministratorLog } from '@Contexts/Groups/Application/IAdministratorLog';
import { AdministratorDecision } from '@Contexts/Groups/Application/IAdministratorDecisions';

import { GroupsDatabase } from './GroupsDatabase';

type LogRow = { id: string; decided_at: string; by_account: string; action: string; subject_id: string };

/** Groups' entries of the administrators' log, kept in its tables in PostgreSQL (request 34): written in the transaction of each change. */
export class SqliteAdministratorLog implements IAdministratorLog {
  constructor(private readonly database: GroupsDatabase) {}

  async record(entry: AdministratorLogEntry): Promise<void> {
    const { id, at, by, action, subjectId } = entry.toSnapshot();
    await this.database.execute(
      'INSERT INTO account_administrator_log (id, decided_at, by_account, action, subject_id) VALUES ($1, $2, $3, $4, $5)',
      [id, at.toISOString(), by, action, subjectId],
    );
  }

  async entries(): Promise<AdministratorDecision[]> {
    const rows = await this.database.rows<LogRow>(
      'SELECT id, decided_at, by_account, action, subject_id FROM account_administrator_log ORDER BY decided_at, seq',
    );
    return rows.map(row => ({
      id: row.id,
      at: row.decided_at,
      by: row.by_account,
      action: row.action as AdministratorDecision['action'],
      subjectId: row.subject_id,
    }));
  }
}
