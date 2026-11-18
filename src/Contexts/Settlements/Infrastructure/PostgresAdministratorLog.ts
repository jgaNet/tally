import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAdministratorLog } from '@Contexts/Settlements/Application/IAdministratorLog';
import { AdministratorAction, AdministratorDecision } from '@Contexts/Settlements/Domain/Settlement/AdministratorLog';
import { IAdministratorLogRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorLogRoster';

/**
 * The administrators' log's table (request 33, ADR 28): one row per decision an administrator made about a contested settlement, written in the
 * transaction of the decision. `id` is the decision's own identity, so a decision written twice meets the primary key. `seq` keeps the entries
 * in the order they were written.
 */
export const administratorLogTablesSchema = [
  `CREATE TABLE IF NOT EXISTS administrator_log (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     at TEXT NOT NULL,
     by_account_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('decided-paid', 'decided-annulled')),
     subject_id TEXT NOT NULL
   )`,
];

interface AdministratorLogRow {
  id: string;
  at: string;
  by_account_id: string;
  action: AdministratorAction;
  subject_id: string;
}

/**
 * The administrators' log in PostgreSQL (request 33, ADR 28): `record` writes a decision in the transaction that made it, and `decisions` reads
 * every decision, the oldest first, as Groups reads it through its own port.
 */
export class PostgresAdministratorLog implements IAdministratorLog, IAdministratorLogRoster {
  constructor(private readonly database: PostgresDatabase) {}

  async record(decision: AdministratorDecision): Promise<void> {
    await this.database.writer
      .prepare('INSERT INTO administrator_log (id, at, by_account_id, action, subject_id) VALUES (?, ?, ?, ?, ?)')
      .run(decision.id, decision.at, decision.by, decision.action, decision.subjectId);
  }

  async decisions(): Promise<AdministratorDecision[]> {
    const rows = (await this.database.read(db =>
      db.prepare('SELECT id, at, by_account_id, action, subject_id FROM administrator_log ORDER BY at, seq').all(),
    )) as unknown as AdministratorLogRow[];
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_account_id,
      action: row.action,
      subjectId: row.subject_id,
    }));
  }
}
