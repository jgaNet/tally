import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { outstandingDebtsReadModel } from '@Bootstrap/Fastify/readModels';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { sweepDebt, sweepDebts } from '@Contexts/Notifications/Application/Debts';
import { ExpenseRecordedIntegrationHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationHandler';
import { BudgetPassedIntegrationHandler } from '@Contexts/Notifications/Application/Events/BudgetPassedIntegrationHandler';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/SqliteNoticeQueries';
import { SqliteNotices } from '@Contexts/Notifications/Infrastructure/SqliteNotices';
import { SqliteDebtWatchQueries, SqliteDebtWatches } from '@Contexts/Notifications/Infrastructure/SqliteDebtWatches';
import { OutstandingDebtsOfSettlements } from '@Contexts/Notifications/Infrastructure/OutstandingDebtsOfSettlements';

/**
 * The Notifications context (conventions/domain.yaml, ADR 11, ADR 0017, ADR 0018): what each person is told. An expense recorded makes one
 * notice per member of its split but its payer, in a reaction to Ledger's published `ExpenseRecorded`; a person lists their own. The
 * background sweep (request 18, docs/adr/0018) notes and reminds a member who owes more than 2000 for a period, reading what is owed
 * through its own port, `OutstandingDebts`, which Settlements answers. Its adapters are the application's SQLite file and that read
 * model; its clock is the system's, given to the reactions and the sweep that record a time.
 */
const notices = new SqliteNotices(sharedDatabase);
const noticeQueries = new SqliteNoticeQueries(sharedDatabase);
const debtWatches = new SqliteDebtWatches(sharedDatabase);
const debtWatchQueries = new SqliteDebtWatchQueries(sharedDatabase);
const outstandingDebts = new OutstandingDebtsOfSettlements(outstandingDebtsReadModel);
const sweep = sweepDebt(debtWatches, notices, systemClock);

export const localNotificationsModule = new LiteModule({
  name: 'Notifications',
  useCases: [getMyNotices(noticeQueries), sweep],
  integrationEvents: [
    { event: ExpenseRecordedIntegrationEvent, handlers: [new ExpenseRecordedIntegrationHandler(notices, systemClock)] },
    // A month passed a budget: one notice to each member, a budget's (request 24, docs/adr/0023).
    { event: BudgetPassedIntegrationEvent, handlers: [new BudgetPassedIntegrationHandler(notices, systemClock)] },
  ],
});

/**
 * The background sweep, run by the composition root at every `JOBS_INTERVAL_SECONDS` (request 18): what a run of the job does for
 * Notifications. `periodMs` is a week, or `REMINDER_PERIOD_SECONDS` when that is set.
 */
export const sweepNotificationDebts = (context: ExecutionContext, periodMs: number): Promise<void> =>
  sweepDebts({ debts: outstandingDebts, watchQueries: debtWatchQueries, sweep, periodMs }, context);
