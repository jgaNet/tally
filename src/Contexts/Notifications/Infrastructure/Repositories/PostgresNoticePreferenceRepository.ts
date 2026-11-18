import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NoticePreferenceKind } from '@Contexts/Notifications/Domain/NoticePreference/DTOs';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceRepository';

/**
 * The table of notice preferences: one row per person, at the version it was last saved at. `off` is the JSON list of the kinds the
 * person has turned off (request 36); a kind not in it is on.
 */
export function createNoticePreferenceTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS notice_preferences (
      person TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      off TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

interface NoticePreferenceRow {
  id: string;
  person: string;
  off: string;
  version: number;
}

/**
 * The notice preferences over the application's PostgreSQL database, inside the transaction of the command or the reaction that reads
 * them. A first set of preferences is inserted at version 1, where a second writer's insert of the same person does nothing; a later one
 * moves the version on only where the stored version is the one it was read at. Either refusal is a ConcurrencyConflictException
 * (CONC-OPTIMISTIC).
 */
export class PostgresNoticePreferenceRepository implements INoticePreferenceRepository {
  constructor(private database: PostgresDatabase) {
    createNoticePreferenceTables(database);
  }

  async findByPerson(person: string): Promise<NoticePreferences | null> {
    const row = await this.database.get<NoticePreferenceRow>(
      'SELECT id, person, off, version FROM notice_preferences WHERE person = ?',
      [person],
    );
    if (!row) return null;
    return NoticePreferences.fromSnapshot({
      _id: row.id,
      person: row.person,
      off: JSON.parse(row.off) as NoticePreferenceKind[],
      version: row.version,
    });
  }

  async save(preferences: NoticePreferences): Promise<IResult> {
    const snapshot = preferences.toSnapshot();
    const off = JSON.stringify(snapshot.off);

    if (snapshot.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO notice_preferences (person, id, off, version) VALUES (?, ?, ?, 1) ON CONFLICT (person) DO NOTHING',
        [snapshot.person, snapshot._id, off],
      );
      if (inserted.changes === 0) return conflict(snapshot.person);
    } else {
      const moved = await this.database.run(
        'UPDATE notice_preferences SET off = ?, version = version + 1 WHERE person = ? AND version = ?',
        [off, snapshot.person, snapshot.version],
      );
      if (moved.changes === 0) return conflict(snapshot.person);
    }
    return Result.ok();
  }
}

function conflict(person: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Notifications', 'The notice preferences changed since they were read', {
      person,
    }),
  );
}
