import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { NoticesForExpenseHandler } from '@Contexts/Notifications/Application/Events/NoticesForExpenseHandler';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { SqliteNoticeStore, notificationsTablesSchema } from '@Contexts/Notifications/Infrastructure/SqliteNoticeStore';

/**
 * The Notifications context (conventions/domain.yaml, ADRs 8 and 13): its wiring, as data. Its table is opened by the composition root
 * with `notificationsSchema`. A notice is made from each ExpenseRecorded the bus hands it (request 17), in the reaction's own
 * transaction, and a person lists their own with `getMyNotices`. It imports no other context: an expense reaches it as the published
 * integration event. The module lists each use case once.
 */
export const notificationsSchema = notificationsTablesSchema;

export function notificationsWiring(database: SqliteDatabase): LiteModule {
  const notices = new SqliteNoticeStore(database);

  return new LiteModule({
    name: 'Notifications',
    useCases: [getMyNotices(notices)],
    integrationEvents: [
      {
        event: ExpenseRecordedIntegrationEvent,
        handlers: [new NoticesForExpenseHandler(notices, systemClock)],
      },
    ],
  });
}
