import { ConcurrencyConflictException } from '@Architecture/Domain';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Application/INoticePreferenceRepository';
import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';

import { NoticesDatabase } from './NoticesDatabase';

type PreferencesRow = {
  id: string;
  member_id: string;
  expense_on: boolean;
  reminder_on: boolean;
  budget_on: boolean;
  version: number;
};

/** The column that holds each kind of notice's switch: fixed names, never taken from a caller. */
const COLUMN: Record<NoticeKind, string> = { expense: 'expense_on', reminder: 'reminder_on', budget: 'budget_on' };

/**
 * The notice preferences in PostgreSQL (request 36, ADR 34): one row per person, one column per kind of notice. A save is checked against
 * the version the preferences were read at, in the transaction that takes the database's writers' lock, so of two saves from the same
 * version the second is refused (CONC-OPTIMISTIC). A person with no row has every kind on.
 */
export class SqliteNoticePreferences implements INoticePreferenceRepository {
  constructor(private readonly database: NoticesDatabase) {}

  async of(memberId: string): Promise<NoticePreferences> {
    const row = await this.database.row<PreferencesRow>(
      'SELECT id, member_id, expense_on, reminder_on, budget_on, version FROM notifications_notice_preferences WHERE member_id = $1',
      [memberId],
    );
    if (!row) return NoticePreferences.defaults(memberId);
    return NoticePreferences.fromSnapshot({
      id: row.id,
      memberId: row.member_id,
      enabled: { expense: row.expense_on, reminder: row.reminder_on, budget: row.budget_on },
      version: row.version,
    });
  }

  async save(preferences: NoticePreferences): Promise<void> {
    const { id, memberId, enabled, version } = preferences.toSnapshot();
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>(
        'SELECT version FROM notifications_notice_preferences WHERE member_id = $1',
        [memberId],
      );
      // Preferences never stored are at version 0; any other are at the version they were stored at.
      if ((stored?.version ?? 0) !== version) {
        throw new ConcurrencyConflictException('Notifications', 'The notice preferences changed since they were read');
      }
      if (stored) {
        await this.database.execute(
          'UPDATE notifications_notice_preferences SET expense_on = $1, reminder_on = $2, budget_on = $3, version = $4 WHERE member_id = $5',
          [enabled.expense, enabled.reminder, enabled.budget, version + 1, memberId],
        );
      } else {
        await this.database.execute(
          'INSERT INTO notifications_notice_preferences (id, member_id, expense_on, reminder_on, budget_on, version) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, memberId, enabled.expense, enabled.reminder, enabled.budget, version + 1],
        );
      }
    });
  }

  async turnedOff(kind: NoticeKind, memberIds: readonly string[]): Promise<Set<string>> {
    if (memberIds.length === 0) return new Set();
    const rows = await this.database.rows<{ member_id: string }>(
      `SELECT member_id FROM notifications_notice_preferences WHERE member_id = ANY($1) AND ${COLUMN[kind]} = FALSE`,
      [[...memberIds]],
    );
    return new Set(rows.map(row => row.member_id));
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }
}
