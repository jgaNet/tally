import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  BudgetPassedIntegrationEvent,
  ExpenseRecordedIntegrationEvent,
} from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { BudgetPassedNoticesHandler } from '@Contexts/Notifications/Application/Events/BudgetPassedNoticesHandler';
import { ExpenseRecordedNoticesHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedNoticesHandler';
import { GetMyNoticesQueryHandler } from '@Contexts/Notifications/Application/Queries';
import { PostgresNoticeQueries } from '@Contexts/Notifications/Infrastructure/PostgresNoticeQueries';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/PostgresNoticeRepository';
import { PostgresDebtWatchRepository } from '@Contexts/Notifications/Infrastructure/PostgresDebtWatchRepository';
import { SweepDebtsJob } from '@Contexts/Notifications/Application/Jobs/SweepDebtsJob';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { Clock } from '@Architecture/Application';

/**
 * The Notifications context (conventions/domain.yaml, ADR 5, ADR 11): one notice to each member of an expense's split but
 * its payer, made when Ledger's ExpenseRecorded arrives, and each person's notices read back, kept in the application's
 * PostgreSQL database (ADR 22). It imports nothing of Ledger but the published event.
 */
const database = PostgresDatabase.shared();

/**
 * The sweep of the debts (ADR 12), built by the composition root with the debts it asks of Settlements, the clock it is
 * given and the reminder period (REMINDER_PERIOD_SECONDS). It runs as a job of the application, never as a request.
 */
export function debtSweepWith(debts: IOutstandingDebts, clock: Clock, reminderPeriodMs: number): SweepDebtsJob {
  return new SweepDebtsJob(
    debts,
    new PostgresDebtWatchRepository(database),
    new PostgresNoticeRepository(database),
    clock,
    reminderPeriodMs,
  );
}

export const localNotificationsModule = new Module({
  name: 'Notifications',
  queries: [new GetMyNoticesQueryHandler(new PostgresNoticeQueries(database))],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedNoticesHandler(new PostgresNoticeRepository(database), systemClock)],
    },
    {
      event: BudgetPassedIntegrationEvent,
      handlers: [new BudgetPassedNoticesHandler(new PostgresNoticeRepository(database), systemClock)],
    },
  ],
});
