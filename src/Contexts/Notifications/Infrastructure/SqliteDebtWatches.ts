import { ConcurrencyConflictException } from '@Architecture/Domain';
import { IDebtWatches } from '@Contexts/Notifications/Application/IDebtWatches';
import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

import { NoticesDatabase } from './NoticesDatabase';
import { INSERT_NOTICE, insertNotice } from './SqliteNotices';

type WatchRow = {
  id: string;
  group_id: string;
  member_id: string;
  noted_since: string | null;
  reminded_at: string | null;
  version: number;
};

/**
 * The debt watches in SQLite (request 18, ADR 15): one row per member and group. The watch's version is checked and stored, with the
 * reminder it made, in one transaction that holds the database's write lock, so that of two servers sweeping the same database from
 * the same version the second is refused and none of its change is kept, its reminder included (CONC-OPTIMISTIC).
 */
export class SqliteDebtWatches implements IDebtWatches {
  constructor(private readonly database: NoticesDatabase) {}

  async all(): Promise<DebtWatch[]> {
    const rows = this.database.connection
      .prepare('SELECT id, group_id, member_id, noted_since, reminded_at, version FROM notifications_debt_watches')
      .all() as WatchRow[];
    return rows.map(row =>
      DebtWatch.fromSnapshot({
        id: row.id,
        groupId: row.group_id,
        memberId: row.member_id,
        notedSince: row.noted_since,
        remindedAt: row.reminded_at,
        version: row.version,
      }),
    );
  }

  async save(watch: DebtWatch, reminder?: Notice): Promise<void> {
    const connection = this.database.connection;
    const { id, groupId, memberId, notedSince, remindedAt } = watch.toSnapshot();
    await this.database.file.transaction(() => {
      const stored = connection
        .prepare('SELECT version FROM notifications_debt_watches WHERE group_id = ? AND member_id = ?')
        .get(groupId, memberId) as { version: number } | undefined;
      // A watch never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== watch.version) {
        throw new ConcurrencyConflictException('Notifications', 'The debt watch changed since it was read');
      }
      if (stored) {
        connection
          .prepare(
            'UPDATE notifications_debt_watches SET noted_since = ?, reminded_at = ?, version = ? WHERE group_id = ? AND member_id = ?',
          )
          .run(notedSince, remindedAt, watch.version + 1, groupId, memberId);
      } else {
        connection
          .prepare(
            'INSERT INTO notifications_debt_watches (id, group_id, member_id, noted_since, reminded_at, version) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, groupId, memberId, notedSince, remindedAt, watch.version + 1);
      }
      if (reminder) {
        insertNotice(connection.prepare(INSERT_NOTICE), reminder);
      }
    });
  }
}
