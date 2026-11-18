import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INoticePreferenceQueries } from '@Contexts/Notifications/Application/Ports/INoticePreferenceQueries';
import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';
import { NOTICE_KINDS } from '@Contexts/Notifications/Domain/NoticePreferences/NoticeKind';
import { createNoticePreferencesTables } from '@Contexts/Notifications/Infrastructure/NoticePreferencesTables';

interface Row {
  expense: boolean;
  reminder: boolean;
  budget: boolean;
}

/** A person's preferences as they are read: the three kinds in order, each on unless a row turned it off. Read outside any transaction. */
export class PostgresNoticePreferenceReadModels implements INoticePreferenceQueries {
  constructor(private database: PostgresDatabase) {
    createNoticePreferencesTables(database);
  }

  async ofOwner(ownerId: string): Promise<NoticePreferenceReadModel[]> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<Row>(
        'SELECT expense, reminder, budget FROM notice_preferences WHERE owner_id = ?',
        ownerId,
      );
      return NOTICE_KINDS.map(kind => ({ kind, enabled: row ? row[kind] : true }));
    });
  }
}
