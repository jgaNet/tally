import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { ExpenseRecordedNoticesHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedNoticesHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/SqliteNoticeQueries';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/SqliteNoticeRepository';

/**
 * The Notifications context (conventions/domain.yaml, ADR 5, ADR 11): one notice to each member of an expense's split but
 * its payer, made when Ledger's ExpenseRecorded arrives, and each person's notices read back, kept in the application's
 * SQLite file (ADR 2). It imports nothing of Ledger but the published event.
 */
const database = SqliteDatabase.shared();

export const localNotificationsModule = new Module({
  name: 'Notifications',
  queries: [new GetMyNoticesQueryHandler(new SqliteNoticeQueries(database))],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedNoticesHandler(new SqliteNoticeRepository(database), systemClock)],
    },
  ],
});
