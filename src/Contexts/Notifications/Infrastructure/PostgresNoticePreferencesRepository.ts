import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';
import { INoticePreferencesRepository } from '@Contexts/Notifications/Domain/NoticePreferences/Ports/INoticePreferencesRepository';
import { createNoticePreferencesTables } from '@Contexts/Notifications/Infrastructure/NoticePreferencesTables';

interface Row {
  id: string;
  owner_id: string;
  expense: boolean;
  reminder: boolean;
  budget: boolean;
  version: number;
}

/**
 * The notice preferences, in the application's file. They are saved at the version they were read at: two changes that read the same
 * row cannot both save it, and the one that loses is a conflict, which its command's bus answers by reading and deciding again.
 */
export class PostgresNoticePreferencesRepository implements INoticePreferencesRepository {
  constructor(private database: PostgresDatabase) {
    createNoticePreferencesTables(database);
  }

  async findByOwner(ownerId: string): Promise<NoticePreferences | null> {
    const row = await this.database.get<Row>(
      'SELECT id, owner_id, expense, reminder, budget, version FROM notice_preferences WHERE owner_id = ?',
      ownerId,
    );
    return row ? toPreferences(row) : null;
  }

  async save(preferences: NoticePreferences): Promise<IResult> {
    const { expense, reminder, budget } = preferences.flags;
    if (preferences.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO notice_preferences (id, owner_id, expense, reminder, budget, version) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        preferences._id.value,
        preferences.ownerId.value,
        expense,
        reminder,
        budget,
      );
      if (!inserted) return conflict(preferences);
    } else {
      const changed = await this.database.run(
        'UPDATE notice_preferences SET expense = ?, reminder = ?, budget = ?, version = ? WHERE id = ? AND version = ?',
        expense,
        reminder,
        budget,
        preferences.version + 1,
        preferences._id.value,
        preferences.version,
      );
      if (!changed) return conflict(preferences);
    }
    return Result.ok();
  }
}

const toPreferences = (row: Row): NoticePreferences =>
  NoticePreferences.fromSnapshot({
    id: row.id,
    ownerId: row.owner_id,
    flags: { expense: row.expense, reminder: row.reminder, budget: row.budget },
    version: row.version,
  });

const conflict = (preferences: NoticePreferences): IResult =>
  Result.fail(
    new ConcurrencyConflictException('Notifications', 'The notice preferences have changed', {
      ownerId: preferences.ownerId.value,
    }),
  );
