import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NOTICE_KINDS, NoticePreferenceView } from '@Contexts/Notifications/Domain/Preference/DTOs';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';
import {
  INoticePreferenceQueries,
  INoticePreferences,
} from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferences';

/**
 * The table of the notice preferences: one row per person (the key `account_id`), a flag per kind of notice, on until turned off, and the
 * version a save checks (request 36, docs/adr/0036). A person never set has no row, and every kind is on.
 */
export async function prepareNoticePreferenceSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS notice_preferences (id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, expense BOOLEAN NOT NULL DEFAULT TRUE, reminder BOOLEAN NOT NULL DEFAULT TRUE, budget BOOLEAN NOT NULL DEFAULT TRUE)',
  );
}

type PreferenceRow = {
  id: string;
  account_id: string;
  version: number;
  expense: boolean;
  reminder: boolean;
  budget: boolean;
};

const changedSinceRead = () =>
  new ConcurrencyConflictException(
    'Notifications',
    'The notice preferences of the person changed since they were read',
  );

/** The notice preferences' store over PostgreSQL. Its methods run inside the transaction of the reaction or the command that asks. */
export class PostgresNoticePreferences implements INoticePreferences {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareNoticePreferenceSchema);
  }

  async get(accountId: string): Promise<NoticePreferences> {
    this.database.assertInTransaction();
    const row = await this.database.get<PreferenceRow>(
      'SELECT id, account_id, version, expense, reminder, budget FROM notice_preferences WHERE account_id = ?',
      [accountId],
    );
    if (!row) return NoticePreferences.open({ accountId });
    return NoticePreferences.fromSnapshot({
      id: String(row.id),
      version: Number(row.version),
      accountId: String(row.account_id),
      expense: Boolean(row.expense),
      reminder: Boolean(row.reminder),
      budget: Boolean(row.budget),
    });
  }

  async save(preferences: NoticePreferences): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const s = preferences.toSnapshot();
    if (preferences.version === 0) {
      const { changes } = await this.database.run(
        'INSERT INTO notice_preferences (id, account_id, version, expense, reminder, budget) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id) DO NOTHING',
        [s.id, s.accountId, 1, s.expense, s.reminder, s.budget],
      );
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = await this.database.run(
        'UPDATE notice_preferences SET expense = ?, reminder = ?, budget = ?, version = ? WHERE id = ? AND version = ?',
        [s.expense, s.reminder, s.budget, preferences.version + 1, s.id, preferences.version],
      );
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    }
    return Result.ok(undefined);
  }
}

/** The read side of the notice preferences, over the same table: a person's own, each kind in the order the API lists them (request 36). */
export class PostgresNoticePreferenceQueries implements INoticePreferenceQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareNoticePreferenceSchema);
  }

  async preferencesOf(accountId: string): Promise<NoticePreferenceView[]> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ expense: boolean; reminder: boolean; budget: boolean }>(
        'SELECT expense, reminder, budget FROM notice_preferences WHERE account_id = ?',
        [accountId],
      );
      return NOTICE_KINDS.map(kind => ({ kind, enabled: row ? Boolean(row[kind]) : true }));
    });
  }
}
