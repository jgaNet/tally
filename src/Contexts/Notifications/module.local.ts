import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Postgres/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { outstandingDebtQueries } from '@Contexts/Settlements/module.local';
import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { BudgetPassedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/BudgetPassedIntegrationEventHandler';
import { RemindLingeringDebtsJob } from '@Contexts/Notifications/Application/Jobs/RemindLingeringDebtsJob';
import {
  GetMyNoticesQueryHandler,
  GetNoticePreferencesQueryHandler,
} from '@Contexts/Notifications/Application/Queries';
import {
  SetNoticePreferenceCommandEvent,
  SetNoticePreferenceCommandHandler,
} from '@Contexts/Notifications/Application/Commands';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticeRepository';
import { PostgresNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/PostgresNoticeQueries';
import { PostgresDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresDebtWatchRepository';
import { PostgresNoticePreferenceRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticePreferenceRepository';
import { PostgresNoticePreferenceQueries } from '@Contexts/Notifications/Infrastructure/Queries/PostgresNoticePreferenceQueries';
import { SettlementsOutstandingDebts } from '@Contexts/Notifications/Infrastructure/Settlements/SettlementsOutstandingDebts';

/**
 * The Notifications context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml,
 * ADR 6): it turns Ledger's published ExpenseRecorded into one notice per member of the split but its payer (ADR 9), lets a
 * signed-in person list their own notices, and reminds a member who has owed more than 2000 for a period (request 18, ADR 10).
 * The clock is the application's, passed to whatever decides or records a time. The reminders' sweep is a job the composition
 * root schedules (`remindLingeringDebts`), and what is still owed comes from Settlements' read model (`outstandingDebtQueries`).
 * A person's notice preferences (request 36) are read where a notice would be made, by the reactions and by the sweep, and set
 * by their own command.
 */
const database = applicationDatabase();
const notices = new PostgresNoticeRepository(database);
const noticeQueries = new PostgresNoticeQueries(database);
const debtWatches = new PostgresDebtWatchRepository(database);
const noticePreferences = new PostgresNoticePreferenceRepository(database);
const noticePreferenceQueries = new PostgresNoticePreferenceQueries(database);
const outstandingDebts = new SettlementsOutstandingDebts(outstandingDebtQueries);
const clock = systemClock;

/** The sweep of request 18: run by the composition root every JOBS_INTERVAL_SECONDS, for a period of REMINDER_PERIOD_SECONDS. */
export const remindLingeringDebts = new RemindLingeringDebtsJob(
  outstandingDebts,
  debtWatches,
  notices,
  noticePreferences,
  clock,
);

export const localNotificationsModule = new Module({
  name: 'Notifications',
  commands: [
    {
      event: SetNoticePreferenceCommandEvent,
      handlers: [new SetNoticePreferenceCommandHandler(noticePreferences)],
    },
  ],
  queries: [new GetMyNoticesQueryHandler(noticeQueries), new GetNoticePreferencesQueryHandler(noticePreferenceQueries)],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, noticePreferences, clock)],
    },
    {
      event: BudgetPassedIntegrationEvent,
      handlers: [new BudgetPassedIntegrationEventHandler(notices, noticePreferences, clock)],
    },
  ],
});
