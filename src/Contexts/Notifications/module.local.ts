import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecorded/ExpenseRecordedIntegrationEventHandler';
import { ReminderIssuedHandler } from '@Contexts/Notifications/Application/Events/ReminderIssued/ReminderIssuedHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries/GetMyNotices';
import { DebtSweepJob } from '@Contexts/Notifications/Application/Jobs/DebtSweep/DebtSweepJob';
import { ReminderIssuedEvent } from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';
import { OutstandingDebtsFromSettlements } from '@Contexts/Notifications/Infrastructure/OutstandingDebtsFromSettlements';
import { SqliteDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/SqliteDebtWatchRepository';
import { SqliteNoticeReadModels } from '@Contexts/Notifications/Infrastructure/SqliteNoticeReadModels';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/SqliteNoticeRepository';
import { outstandingDebtsQueries } from '@Contexts/Settlements/module.local';

const database = sharedDatabase();
const notices = new SqliteNoticeRepository(database);
const noticeReadModels = new SqliteNoticeReadModels(database);
const debtWatches = new SqliteDebtWatchRepository(database);

/** What each member still owes, read through the port Notifications owns (ADR 10): Settlements' read model, read when it is asked. */
const outstandingDebts = new OutstandingDebtsFromSettlements(() => outstandingDebtsQueries);

/**
 * The debt sweep (ADR 10), run by the process every JOBS_INTERVAL_SECONDS (Bootstrap's `startJobs`). A week is
 * REMINDER_PERIOD_SECONDS seconds, 604 800 when that is not set. It takes the one clock, as the handlers do.
 */
export const debtSweep = new DebtSweepJob(
  outstandingDebts,
  debtWatches,
  systemClock,
  Number(process.env.REMINDER_PERIOD_SECONDS) || 604800,
);

/**
 * The Notifications context (conventions/domain.yaml, ADR 5, ADR 10): a notice to each member of an expense's split but its payer,
 * made from Ledger's ExpenseRecorded; a reminder to a member who has owed for a period, made from the sweep's ReminderIssued; and a
 * person's own notices, read on their own.
 */
export const localNotificationsModule = new Module({
  name: 'Notifications',
  queries: [new GetMyNoticesQueryHandler(noticeReadModels)],
  domainEvents: [{ event: ReminderIssuedEvent, handlers: [new ReminderIssuedHandler(notices)] }],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, systemClock)],
    },
  ],
});
