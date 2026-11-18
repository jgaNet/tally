import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NOTICE_KINDS, NoticePreferenceKind } from '@Contexts/Notifications/Domain/NoticePreference/DTOs';
import {
  INoticePreferenceQueries,
  NoticePreferenceView,
} from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceQueries';
import { createNoticePreferenceTables } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticePreferenceRepository';

/** A person's notice preferences, read from the table the repository keeps: every kind, on unless it is in the list turned off. */
export class PostgresNoticePreferenceQueries implements INoticePreferenceQueries {
  constructor(private database: PostgresDatabase) {
    createNoticePreferenceTables(database);
  }

  async ofPerson(person: string): Promise<NoticePreferenceView[]> {
    const row = await this.database.get<{ off: string }>('SELECT off FROM notice_preferences WHERE person = ?', [
      person,
    ]);
    const off = new Set<NoticePreferenceKind>(row ? (JSON.parse(row.off) as NoticePreferenceKind[]) : []);
    return NOTICE_KINDS.map(kind => ({ kind, enabled: !off.has(kind) }));
  }
}
