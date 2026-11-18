import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INoticePreferenceStore } from '@Contexts/Notifications/Application/INoticePreferenceStore';
import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

/**
 * The notice preferences' table (request 36): one row per person, the kinds they have turned off as a JSON list, and the version the
 * preferences are at. A person with no row has every kind on.
 */
export const noticePreferencesTablesSchema = [
  `CREATE TABLE IF NOT EXISTS notice_preferences (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL UNIQUE,
     off TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
];

interface NoticePreferencesRow {
  id: string;
  owner_id: string;
  off: string;
  version: number;
}

/**
 * The notice preferences in PostgreSQL. `save` stores new preferences (version 0) with their first row, and changed ones at their version + 1,
 * each only while they are still at the version read; otherwise it refuses with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class PostgresNoticePreferenceStore implements INoticePreferenceStore {
  constructor(private readonly database: PostgresDatabase) {}

  async preferencesOf(ownerId: string): Promise<NoticePreferences> {
    const row = (await this.database.read(db =>
      db.prepare('SELECT * FROM notice_preferences WHERE owner_id = ?').get(ownerId),
    )) as NoticePreferencesRow | undefined;
    if (!row) return NoticePreferences.create({ ownerId });
    return NoticePreferences.fromSnapshot({
      id: row.id,
      ownerId: row.owner_id,
      off: JSON.parse(row.off) as NoticeKind[],
      version: row.version,
    });
  }

  async save(preferences: NoticePreferences): Promise<void> {
    const writer = this.database.writer;
    const snapshot = preferences.toSnapshot();
    const off = JSON.stringify(snapshot.off);
    const { changes } = await (snapshot.version === 0
      ? writer
          .prepare(
            'INSERT INTO notice_preferences (id, owner_id, off, version) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING',
          )
          .run(snapshot.id, snapshot.ownerId, off)
      : writer
          .prepare('UPDATE notice_preferences SET off = ?, version = ? WHERE id = ? AND version = ?')
          .run(off, snapshot.version + 1, snapshot.id, snapshot.version));
    if (changes === 0) {
      throw new ConcurrencyConflictException(
        'Notifications',
        'The notice preferences changed since they were read: read them again',
      );
    }
  }
}
