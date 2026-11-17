import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { NoticesDatabase } from '@Contexts/Notifications/Infrastructure/NoticesDatabase';
import { SqliteNotices } from '@Contexts/Notifications/Infrastructure/SqliteNotices';

/**
 * The Notifications context, as data (ADR 9, ADR 14): its notices in SQLite at `NOTIFICATIONS_DATABASE_PATH`, or the application's
 * database file (`DATABASE_PATH`) when that is not set. It is told of an expense only by Ledger's integration event, which its
 * reaction turns into one notice per member; it asks no other context.
 */
const database = new NoticesDatabase(
  () => process.env.NOTIFICATIONS_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
const notices = new SqliteNotices(database);

export const localNotificationsModule = new LiteModule({
  name: 'Notifications',
  useCases: [getMyNotices(notices)],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, systemClock)],
    },
  ],
});
