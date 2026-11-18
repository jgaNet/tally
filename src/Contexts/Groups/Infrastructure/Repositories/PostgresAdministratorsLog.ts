import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { AdministratorDecision } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';
import {
  IAdministratorsLog,
  IAdministratorsLogQueries,
} from '@Contexts/Groups/Domain/Account/Ports/IAdministratorsLog';

/** The table of Groups' entries of the administrators' log: one row per entry, numbered in the order they were written (request 34). */
export function createAdministratorsLogTable(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS administrators_log (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      by TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_id TEXT NOT NULL
    );
  `);
}

interface AdministratorsLogRow {
  id: string;
  at: string;
  by: string;
  action: string;
  subject_id: string;
}

/**
 * Groups' entries of the administrators' log over the application's PostgreSQL database. An entry is written in the transaction of
 * the change it logs, and the log is read oldest first.
 */
export class PostgresAdministratorsLog implements IAdministratorsLog, IAdministratorsLogQueries {
  constructor(private database: PostgresDatabase) {
    createAdministratorsLogTable(database);
  }

  async record({ id, at, by, action, subjectId }: AdministratorDecision): Promise<void> {
    await this.database.run('INSERT INTO administrators_log (id, at, by, action, subject_id) VALUES (?, ?, ?, ?, ?)', [
      id,
      at,
      by,
      action,
      subjectId,
    ]);
  }

  async all(): Promise<AdministratorDecision[]> {
    const rows = await this.database.all<AdministratorsLogRow>(
      'SELECT id, at, by, action, subject_id FROM administrators_log ORDER BY seq',
    );
    return rows.map(row => ({ id: row.id, at: row.at, by: row.by, action: row.action, subjectId: row.subject_id }));
  }
}
