import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IDebtWatchStore } from '@Contexts/Notifications/Application/IDebtWatchStore';
import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

/**
 * The debt watches' table (request 18): one row per member and group, with the run that first saw the debt above the threshold (`noted_at`,
 * null once it is cleared), the last reminder (`last_reminder_at`, kept), and the version the watch is at. Its `(group_id, member_id)` is
 * unique, so two servers that first see the same debt cannot both create its watch.
 */
export const debtWatchesTablesSchema = [
  `CREATE TABLE IF NOT EXISTS debt_watches (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     noted_at TEXT,
     last_reminder_at TEXT,
     version INTEGER NOT NULL,
     UNIQUE (group_id, member_id)
   )`,
];

interface DebtWatchRow {
  id: string;
  group_id: string;
  member_id: string;
  noted_at: string | null;
  last_reminder_at: string | null;
  version: number;
}

/**
 * The watches in SQLite. `save` checks the watch is still at the version it was read at and stores the next one, in the sweep's
 * transaction; it refuses a watch another run moved on with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqliteDebtWatchStore implements IDebtWatchStore {
  constructor(private readonly database: SqliteDatabase) {}

  async all(): Promise<DebtWatch[]> {
    const rows = this.database.read(db => db.prepare('SELECT * FROM debt_watches').all()) as unknown as DebtWatchRow[];
    return rows.map(row =>
      DebtWatch.fromSnapshot({
        id: row.id,
        groupId: row.group_id,
        memberId: row.member_id,
        ...(row.noted_at !== null && { notedAt: row.noted_at }),
        ...(row.last_reminder_at !== null && { lastReminderAt: row.last_reminder_at }),
        version: row.version,
      }),
    );
  }

  async save(watch: DebtWatch): Promise<void> {
    const snapshot = watch.toSnapshot();
    const writer = this.database.writer;
    const { changes } =
      watch.version === 0
        ? writer
            .prepare(
              `INSERT OR IGNORE INTO debt_watches (id, group_id, member_id, noted_at, last_reminder_at, version)
               VALUES (?, ?, ?, ?, ?, 1)`,
            )
            .run(
              snapshot.id,
              snapshot.groupId,
              snapshot.memberId,
              snapshot.notedAt ?? null,
              snapshot.lastReminderAt ?? null,
            )
        : writer
            .prepare(
              'UPDATE debt_watches SET noted_at = ?, last_reminder_at = ?, version = ? WHERE id = ? AND version = ?',
            )
            .run(
              snapshot.notedAt ?? null,
              snapshot.lastReminderAt ?? null,
              watch.version + 1,
              snapshot.id,
              watch.version,
            );
    if (changes === 0) {
      throw new ConcurrencyConflictException(
        'Notifications',
        'The debt of the member changed since the sweep read it: the sweep decides again',
      );
    }
  }
}
