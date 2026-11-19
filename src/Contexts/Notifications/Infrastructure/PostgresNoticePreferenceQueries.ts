import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { INoticePreferenceQueries } from '@Contexts/Notifications/Application/Ports/INoticePreferenceQueries';
import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';
import { NOTICE_PREFERENCE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/preferences.schema';

interface PreferenceRow {
  expense_on: boolean;
  reminder_on: boolean;
  budget_on: boolean;
}

/** What a person reads of their notice preferences, outside any transaction: a kind with no row is on. */
export class PostgresNoticePreferenceQueries implements INoticePreferenceQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(NOTICE_PREFERENCE_STATEMENTS);
  }

  async preferencesOf(memberId: string): Promise<NoticePreferenceReadModel[]> {
    const row = await this.database.exclusive(connection =>
      connection.row<PreferenceRow>(
        `SELECT expense_on, reminder_on, budget_on FROM notifications_notice_preferences WHERE member_id = ?`,
        memberId,
      ),
    );
    return [
      { kind: 'expense', enabled: row?.expense_on ?? true },
      { kind: 'reminder', enabled: row?.reminder_on ?? true },
      { kind: 'budget', enabled: row?.budget_on ?? true },
    ];
  }
}
