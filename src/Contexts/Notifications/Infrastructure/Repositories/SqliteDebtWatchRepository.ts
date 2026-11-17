import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { IDebtWatchRepository } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IDebtWatchRepository';

/** The table of debt watches: one row per member and group, at the version it was last saved at (ADR 10). */
export function createDebtWatchTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS debt_watches (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      noted_since TEXT,
      last_reminded TEXT,
      version INTEGER NOT NULL,
      UNIQUE (group_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS debt_watches_noted ON debt_watches (noted_since);
  `);
}

interface DebtWatchRow {
  id: string;
  group_id: string;
  member_id: string;
  noted_since: string | null;
  last_reminded: string | null;
  version: number;
}

/**
 * The debt watches over the application's SQLite file, inside the sweep's transaction. A first watch is inserted at version 1,
 * where a second writer's insert of the same member and group does nothing; a later one moves the version on only where the
 * stored version is the one it was read at. Either refusal is a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqliteDebtWatchRepository implements IDebtWatchRepository {
  constructor(private database: SqliteDatabase) {
    createDebtWatchTables(database);
  }

  async findBy(groupId: string, memberId: string): Promise<DebtWatch | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM debt_watches WHERE group_id = ? AND member_id = ?')
      .get(groupId, memberId) as DebtWatchRow | undefined;
    return row ? DebtWatch.fromSnapshot(toSnapshot(row)) : null;
  }

  async notedMembers(): Promise<{ groupId: string; memberId: string }[]> {
    const rows = this.database.connection
      .prepare('SELECT group_id, member_id FROM debt_watches WHERE noted_since IS NOT NULL')
      .all() as { group_id: string; member_id: string }[];
    return rows.map(row => ({ groupId: row.group_id, memberId: row.member_id }));
  }

  async save(watch: DebtWatch): Promise<IResult> {
    const snapshot = watch.toSnapshot();
    const connection = this.database.connection;

    if (snapshot.version === 0) {
      const inserted = connection
        .prepare(
          `INSERT INTO debt_watches (id, group_id, member_id, noted_since, last_reminded, version) VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT (group_id, member_id) DO NOTHING`,
        )
        .run(
          snapshot._id,
          snapshot.groupId,
          snapshot.memberId,
          snapshot.notedSince?.toISOString() ?? null,
          snapshot.lastReminded?.toISOString() ?? null,
        );
      if (inserted.changes === 0) return conflict(snapshot.groupId, snapshot.memberId);
      return Result.ok();
    }

    const moved = connection
      .prepare(
        `UPDATE debt_watches SET noted_since = ?, last_reminded = ?, version = version + 1
         WHERE group_id = ? AND member_id = ? AND version = ?`,
      )
      .run(
        snapshot.notedSince?.toISOString() ?? null,
        snapshot.lastReminded?.toISOString() ?? null,
        snapshot.groupId,
        snapshot.memberId,
        snapshot.version,
      );
    if (moved.changes === 0) return conflict(snapshot.groupId, snapshot.memberId);
    return Result.ok();
  }
}

function toSnapshot(row: DebtWatchRow) {
  return {
    _id: row.id,
    groupId: row.group_id,
    memberId: row.member_id,
    notedSince: row.noted_since === null ? null : new Date(row.noted_since),
    lastReminded: row.last_reminded === null ? null : new Date(row.last_reminded),
    version: row.version,
  };
}

function conflict(groupId: string, memberId: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Notifications', 'The debt was decided again since it was read', {
      groupId,
      memberId,
    }),
  );
}
