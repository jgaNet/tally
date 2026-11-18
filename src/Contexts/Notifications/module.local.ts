import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';
import { NoticesForBudgetHandler } from '@Contexts/Notifications/Application/Events/NoticesForBudgetHandler';
import { NoticesForExpenseHandler } from '@Contexts/Notifications/Application/Events/NoticesForExpenseHandler';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';
import { sweepDebts } from '@Contexts/Notifications/Application/DebtSweep';
import {
  PostgresNoticeStore,
  notificationsTablesSchema,
} from '@Contexts/Notifications/Infrastructure/PostgresNoticeStore';
import {
  PostgresDebtWatchStore,
  debtWatchesTablesSchema,
} from '@Contexts/Notifications/Infrastructure/PostgresDebtWatchStore';
import { IOutstandingDebts } from '@Contexts/Notifications/Application/IOutstandingDebts';

/**
 * The Notifications context (conventions/domain.yaml, ADRs 8, 13 and 14): its wiring, as data. Its tables are opened by the composition
 * root with `notificationsSchema`. A notice is made from each ExpenseRecorded the bus hands it (request 17), in the reaction's own
 * transaction, and a person lists their own with `getMyNotices`. A reminder (request 18) is made by the background sweep, `sweepDebts`,
 * which the composition root runs every JOBS_INTERVAL_SECONDS: it asks what every member still owes through `debts`, its own port, which
 * the composition root answers over Settlements' read model, and keeps its watches in this context's own table. An expense reaches it as the published integration event, and a debt as the
 * port the sweep owns: this file imports no other context. The module lists each use case once.
 */
export const notificationsSchema = [...notificationsTablesSchema, ...debtWatchesTablesSchema];

/** What the sweep needs of the environment: how long a debt must last before it is reminded, in milliseconds (REMINDER_PERIOD_SECONDS). */
export interface NotificationsConfig {
  readonly reminderPeriodMs: number;
}

export function notificationsWiring(
  database: PostgresDatabase,
  debts: IOutstandingDebts,
  config: NotificationsConfig,
): LiteModule {
  const notices = new PostgresNoticeStore(database);
  const watches = new PostgresDebtWatchStore(database);

  return new LiteModule({
    name: 'Notifications',
    useCases: [getMyNotices(notices), sweepDebts(watches, debts, notices, systemClock, config.reminderPeriodMs)],
    integrationEvents: [
      {
        event: ExpenseRecordedIntegrationEvent,
        handlers: [new NoticesForExpenseHandler(notices, systemClock)],
      },
      {
        event: BudgetPassedIntegrationEvent,
        handlers: [new NoticesForBudgetHandler(notices, systemClock)],
      },
    ],
  });
}
