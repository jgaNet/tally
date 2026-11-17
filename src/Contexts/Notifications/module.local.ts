import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { ExpenseRecordedIntegrationHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationHandler';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/SqliteNoticeQueries';
import { SqliteNotices } from '@Contexts/Notifications/Infrastructure/SqliteNotices';

/**
 * The Notifications context (conventions/domain.yaml, ADR 11, ADR 0017): what each person is told. Its first request: an expense
 * recorded makes one notice per member of its split but its payer, in a reaction to Ledger's published `ExpenseRecorded`; a person
 * lists their own. Its adapters are the application's SQLite file; its clock is the system's, given to the reaction that records a time.
 */
const notices = new SqliteNotices(sharedDatabase);
const noticeQueries = new SqliteNoticeQueries(sharedDatabase);

export const localNotificationsModule = new LiteModule({
  name: 'Notifications',
  useCases: [getMyNotices(noticeQueries)],
  integrationEvents: [
    { event: ExpenseRecordedIntegrationEvent, handlers: [new ExpenseRecordedIntegrationHandler(notices, systemClock)] },
  ],
});
