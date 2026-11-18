import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  BudgetPassedIntegrationEvent,
  ExpenseRecordedIntegrationEvent,
} from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

import { BudgetPassedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/BudgetPassed/BudgetPassedIntegrationEventHandler';
import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecorded/ExpenseRecordedIntegrationEventHandler';
import { ReminderIssuedHandler } from '@Contexts/Notifications/Application/Events/ReminderIssued/ReminderIssuedHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries/GetMyNotices';
import { GetNoticePreferencesQueryHandler } from '@Contexts/Notifications/Application/Queries/GetNoticePreferences';
import {
  SetNoticePreferenceCommandEvent,
  SetNoticePreferenceCommandHandler,
} from '@Contexts/Notifications/Application/Commands/SetNoticePreference';
import { DebtSweepJob } from '@Contexts/Notifications/Application/Jobs/DebtSweep/DebtSweepJob';
import { ReminderIssuedEvent } from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';
import { OutstandingDebtsFromSettlements } from '@Contexts/Notifications/Infrastructure/OutstandingDebtsFromSettlements';
import { PostgresDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/PostgresDebtWatchRepository';
import { PostgresNoticeReadModels } from '@Contexts/Notifications/Infrastructure/PostgresNoticeReadModels';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/PostgresNoticeRepository';
import { PostgresNoticePreferencesRepository } from '@Contexts/Notifications/Infrastructure/PostgresNoticePreferencesRepository';
import { PostgresNoticePreferenceReadModels } from '@Contexts/Notifications/Infrastructure/PostgresNoticePreferenceReadModels';
import { outstandingDebtsQueries } from '@Contexts/Settlements/module.local';

const database = sharedDatabase();
const notices = new PostgresNoticeRepository(database);
const noticeReadModels = new PostgresNoticeReadModels(database);
const debtWatches = new PostgresDebtWatchRepository(database);
/** Each person's kinds of notice, on or off (request 36): read by the reactions that would make a notice, and by the person's own read. */
const noticePreferences = new PostgresNoticePreferencesRepository(database);
const noticePreferenceReadModels = new PostgresNoticePreferenceReadModels(database);

/** What each member still owes, read through the port Notifications owns (ADR 10): Settlements' read model, read when it is asked. */
const outstandingDebts = new OutstandingDebtsFromSettlements(() => outstandingDebtsQueries);

/**
 * The debt sweep (ADR 10), run by the process every JOBS_INTERVAL_SECONDS (Bootstrap's `startJobs`). A week is
 * REMINDER_PERIOD_SECONDS seconds, 604 800 when that is not set. It takes the one clock, as the handlers do.
 */
export const debtSweep = new DebtSweepJob(
  outstandingDebts,
  debtWatches,
  noticePreferences,
  systemClock,
  Number(process.env.REMINDER_PERIOD_SECONDS) || 604800,
);

/**
 * The Notifications context (conventions/domain.yaml, ADR 5, ADR 10): a notice to each member of an expense's split but its payer,
 * made from Ledger's ExpenseRecorded; a notice to each member when a month passes a category's budget, made from Ledger's BudgetPassed (request 24); a reminder to a member who has owed for a period, made from the sweep's ReminderIssued; and a
 * person's own notices, read on their own.
 */
export const localNotificationsModule = new Module({
  name: 'Notifications',
  commands: [
    {
      event: SetNoticePreferenceCommandEvent,
      handlers: [new SetNoticePreferenceCommandHandler(noticePreferences, systemClock)],
    },
  ],
  queries: [
    new GetMyNoticesQueryHandler(noticeReadModels),
    new GetNoticePreferencesQueryHandler(noticePreferenceReadModels),
  ],
  domainEvents: [{ event: ReminderIssuedEvent, handlers: [new ReminderIssuedHandler(notices)] }],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, noticePreferences, systemClock)],
    },
    {
      event: BudgetPassedIntegrationEvent,
      handlers: [new BudgetPassedIntegrationEventHandler(notices, noticePreferences, systemClock)],
    },
  ],
});
