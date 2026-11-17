import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecorded/ExpenseRecordedIntegrationEventHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries/GetMyNotices';
import { SqliteNoticeReadModels } from '@Contexts/Notifications/Infrastructure/SqliteNoticeReadModels';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/SqliteNoticeRepository';

const database = sharedDatabase();
const notices = new SqliteNoticeRepository(database);
const noticeReadModels = new SqliteNoticeReadModels(database);

/**
 * The Notifications context (conventions/domain.yaml, ADR 5): a notice to each member of an expense's split but its payer, made
 * from Ledger's ExpenseRecorded, and a person's own notices, read on their own.
 */
export const localNotificationsModule = new Module({
  name: 'Notifications',
  queries: [new GetMyNoticesQueryHandler(noticeReadModels)],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, systemClock)],
    },
  ],
});
