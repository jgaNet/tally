import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteNoticeRepository';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/SqliteNoticeQueries';

/**
 * The Notifications context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml,
 * ADR 6), carried since request 17 (ADR 9): it turns Ledger's published ExpenseRecorded into one notice per member of the
 * split but its payer, kept in the application's SQLite file, and lets a signed-in person list their own notices. The
 * clock is the application's, passed to the reaction that decides when a notice is made.
 */
const database = applicationDatabase();
const notices = new SqliteNoticeRepository(database);
const noticeQueries = new SqliteNoticeQueries(database);
const clock = systemClock;

export const localNotificationsModule = new Module({
  name: 'Notifications',
  queries: [new GetMyNoticesQueryHandler(noticeQueries)],
  integrationEvents: [
    { event: ExpenseRecordedIntegrationEvent, handlers: [new ExpenseRecordedIntegrationEventHandler(notices, clock)] },
  ],
});
