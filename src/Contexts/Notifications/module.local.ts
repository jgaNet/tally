import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { ExpenseRecordedIntegrationEventHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationEventHandler';
import { sweepDebts } from '@Contexts/Notifications/Application/Reminders';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { outstandingDebtsReadModel } from '@Contexts/Settlements/module.local';
import { NoticesDatabase } from '@Contexts/Notifications/Infrastructure/NoticesDatabase';
import { OutstandingDebtsOfSettlements } from '@Contexts/Notifications/Infrastructure/OutstandingDebtsOfSettlements';
import { SqliteDebtWatches } from '@Contexts/Notifications/Infrastructure/SqliteDebtWatches';
import { SqliteNotices } from '@Contexts/Notifications/Infrastructure/SqliteNotices';

/**
 * The Notifications context, as data (ADR 9, ADR 14): its notices in SQLite at `NOTIFICATIONS_DATABASE_PATH`, or the application's
 * database file (`DATABASE_PATH`) when that is not set. It is told of an expense only by Ledger's integration event, which its
 * reaction turns into one notice per member; it asks Settlements, through a port it owns, what each member still owes when the background job sweeps (request 18, ADR 15).
 */
const database = new NoticesDatabase(
  () => process.env.NOTIFICATIONS_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
const notices = new SqliteNotices(database);
const debtWatches = new SqliteDebtWatches(database);
const outstandingDebts = new OutstandingDebtsOfSettlements(() => outstandingDebtsReadModel);

const DEFAULT_PERIOD_SECONDS = 604_800;
/** A week, or `REMINDER_PERIOD_SECONDS` seconds when that is set (to a number above 0), read when a run starts (request 18). */
const reminderPeriodMs = (): number => {
  const seconds = Number(process.env.REMINDER_PERIOD_SECONDS);
  return (seconds > 0 && Number.isFinite(seconds) ? seconds : DEFAULT_PERIOD_SECONDS) * 1000;
};

export const localNotificationsModule = new LiteModule({
  name: 'Notifications',
  useCases: [getMyNotices(notices), sweepDebts(outstandingDebts, debtWatches, systemClock, reminderPeriodMs)],
  integrationEvents: [
    {
      event: ExpenseRecordedIntegrationEvent,
      handlers: [new ExpenseRecordedIntegrationEventHandler(notices, systemClock)],
    },
  ],
});
