import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferenceRepository';
import { NOTICE_PREFERENCE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/preferences.schema';

interface PreferenceRow {
  id: string;
  member_id: string;
  expense_on: boolean;
  reminder_on: boolean;
  budget_on: boolean;
  version: number;
}

/**
 * The notice preferences over the PostgreSQL database (ADR 27), used in the transaction the command, the reaction or the sweep
 * holds. A save stores version + 1 only where the stored version is the one read; a first save inserts the row only where
 * none is stored, so two first changes of one person cannot both win: the one that loses gets a ConcurrencyConflictException,
 * re-reads and re-decides.
 */
export class PostgresNoticePreferenceRepository implements INoticePreferenceRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(NOTICE_PREFERENCE_STATEMENTS);
  }

  async findByMember(memberId: Id): Promise<NoticePreferences | null> {
    const row = await this.database.connection.row<PreferenceRow>(
      `SELECT id, member_id, expense_on, reminder_on, budget_on, version
         FROM notifications_notice_preferences WHERE member_id = ?`,
      memberId.value,
    );
    if (!row) return null;
    return NoticePreferences.fromSnapshot(
      {
        id: row.id,
        memberId: row.member_id,
        expense: row.expense_on,
        reminder: row.reminder_on,
        budget: row.budget_on,
      },
      Number(row.version),
    );
  }

  async save(preferences: NoticePreferences): Promise<IResult> {
    const { connection } = this.database;
    const { id, memberId, expense, reminder, budget } = preferences.toSnapshot();
    if (preferences.version === 0) {
      const { changes } = await connection.run(
        `INSERT INTO notifications_notice_preferences (id, member_id, expense_on, reminder_on, budget_on, version)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT DO NOTHING`,
        id,
        memberId,
        expense,
        reminder,
        budget,
      );
      if (changes === 0) return conflict(memberId);
    } else {
      const { changes } = await connection.run(
        `UPDATE notifications_notice_preferences
            SET expense_on = ?, reminder_on = ?, budget_on = ?, version = version + 1
          WHERE id = ? AND version = ?`,
        expense,
        reminder,
        budget,
        id,
        preferences.version,
      );
      if (changes === 0) return conflict(memberId);
    }
    return Result.ok();
  }
}

function conflict(memberId: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException(
      'Notifications',
      'The notice preferences of the person changed since they were read',
      {
        memberId,
      },
    ),
  );
}
