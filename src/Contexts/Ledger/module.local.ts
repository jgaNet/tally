import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Postgres/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { groupQueries } from '@Contexts/Groups/module.local';
import {
  SetUpRecurringExpenseCommandEvent,
  SetUpRecurringExpenseCommandHandler,
  StopRecurringExpenseCommandEvent,
  StopRecurringExpenseCommandHandler,
  DeleteExpenseCommandEvent,
  DeleteExpenseCommandHandler,
  EditExpenseCommandEvent,
  EditExpenseCommandHandler,
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
  SetBudgetCommandEvent,
  SetBudgetCommandHandler,
  RemoveBudgetCommandEvent,
  RemoveBudgetCommandHandler,
  SaveTemplateCommandEvent,
  SaveTemplateCommandHandler,
  ReplaceTemplateCommandEvent,
  ReplaceTemplateCommandHandler,
  RemoveTemplateCommandEvent,
  RemoveTemplateCommandHandler,
  AttachReceiptCommandEvent,
  AttachReceiptCommandHandler,
} from '@Contexts/Ledger/Application/Commands';
import {
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupExpensesQueryHandler,
  GetMemberStatementQueryHandler,
  GetMemberStatementCsvQueryHandler,
  GetOfferedRateQueryHandler,
  GetRecurringExpenseQueryHandler,
  GetGroupRecurringExpensesQueryHandler,
  GetGroupBudgetsQueryHandler,
  GetGroupTemplatesQueryHandler,
  GetReceiptQueryHandler,
  GetGroupAuditQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseRecordedBudgetHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedBudgetHandler';
import { ExpenseEditedBudgetHandler } from '@Contexts/Ledger/Application/Events/ExpenseEditedBudgetHandler';
import { ExpenseBudgetPolicy } from '@Contexts/Ledger/Application/Events/ExpenseBudgetPolicy';
import { BudgetPassedHandler } from '@Contexts/Ledger/Application/Events/BudgetPassedHandler';
import { RecurringExpenseDayCameHandler } from '@Contexts/Ledger/Application/Events/RecurringExpenseDayCameHandler';
import { RecordRecurringExpensesJob } from '@Contexts/Ledger/Application/Jobs/RecordRecurringExpensesJob';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { PostgresBudgetRepository } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresBudgetRepository';
import { PostgresBudgetQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresBudgetQueries';
import { PostgresSplitTemplateRepository } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresSplitTemplateRepository';
import { PostgresSplitTemplateQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresSplitTemplateQueries';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { PostgresRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresRecurringExpenseRepository';
import { PostgresRecurringExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresRecurringExpenseQueries';
import { PostgresExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';
import { PostgresExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresExpenseQueries';
import { PostgresBalanceQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresBalanceQueries';
import { PostgresStatementQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresStatementQueries';
import { GroupsMembership } from '@Contexts/Ledger/Infrastructure/Groups/GroupsMembership';
import { GroupsCurrency } from '@Contexts/Ledger/Infrastructure/Groups/GroupsCurrency';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/Settlements/SettlementsSettledAmounts';
import { HttpOfferedRates } from '@Contexts/Ledger/Infrastructure/Rates/HttpOfferedRates';
import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/Receipts/HttpReceiptStore';
import { PostgresReceiptRepository } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresReceiptRepository';
import { PostgresReceiptQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresReceiptQueries';
import { settlementQueries } from '@Contexts/Settlements/module.local';
import { PostgresAuditQueries } from '@Contexts/Ledger/Infrastructure/Queries/PostgresAuditQueries';
import { SettlementsSettlementAudit } from '@Contexts/Ledger/Infrastructure/Settlements/SettlementsSettlementAudit';
import { GroupsPassedBalances } from '@Contexts/Ledger/Infrastructure/Groups/GroupsPassedBalances';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';
import { GroupsMergedIntegrationEventHandler } from '@Contexts/Ledger/Application/Events/GroupsMergedIntegrationEventHandler';
import { PostgresAuditEntries } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresAuditEntries';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3): the expenses of each group, kept in the application's
 * PostgreSQL database, with the balances read model written by each expense (ADR 1). It asks Groups who may be in a split, and
 * who the members of a group are, through its own port, answered over Groups' read model; it asks the rates service the rate
 * offered for an expense in another currency, through its own port (request 22); the clock is the application's,
 * passed to what decides a time: an expense's day. An expense's recording is published to the other contexts as
 * ExpenseRecorded (request 17, ADR 6), through the outbox. A recurring expense (request 23) is set up and stopped by its commands, and
 * its days are recorded by the background job `recordRecurringExpenses`, which the composition root schedules; the expense of a day is
 * recorded by the policy on its fact.
 */
const database = applicationDatabase();
const expenses = new PostgresExpenseRepository(database);
const expenseQueries = new PostgresExpenseQueries(database);
const groupMembers = new GroupsMembership(groupQueries);
const groupCurrency = new GroupsCurrency(groupQueries);
/** The rates service is asked where RATES_URL points when a rate is asked, so an unset URL offers none (request 22). */
const offeredRates = new HttpOfferedRates(() => process.env.RATES_URL);
/** Settlements, as Ledger counts them: the balances and the statements read them through this one port (request 29). */
const settledAmounts = new SettlementsSettledAmounts(settlementQueries);
const balanceQueries = new PostgresBalanceQueries(database, settledAmounts, groupMembers);
const statementQueries = new PostgresStatementQueries(database);
const recurring = new PostgresRecurringExpenseRepository(database);
const recurringQueries = new PostgresRecurringExpenseQueries(database);
const budgets = new PostgresBudgetRepository(database);
const budgetQueries = new PostgresBudgetQueries(database);
const templates = new PostgresSplitTemplateRepository(database);
const templateQueries = new PostgresSplitTemplateQueries(database);
/** The receipts store is asked where RECEIPTS_URL points when a receipt is attached, so an unset URL refuses it (request 26). */
const receiptStore = new HttpReceiptStore(() => process.env.RECEIPTS_URL);
const receipts = new PostgresReceiptRepository(database);
const receiptQueries = new PostgresReceiptQueries(database);
/** The policy on an expense recorded or edited (request 24): its month, in its category, is what the budget decides. */
const budgetPolicy = new ExpenseBudgetPolicy(expenses, budgets, budgetQueries, groupMembers);
/** The audit (request 28): Ledger's own entries, and the settlements' and the passed balances', read through its two ports (ADR 19). */
const auditQueries = new PostgresAuditQueries(database);
const settlementAudit = new SettlementsSettlementAudit(settlementQueries);
const passedBalances = new GroupsPassedBalances(groupQueries);
/** The audit entries a merge moves to the group kept (request 31): the table the expenses keep. */
const auditEntries = new PostgresAuditEntries(database);
const clock = systemClock;

/** The sweep of request 23: run by the composition root every JOBS_INTERVAL_SECONDS, recording each day that has come, once. */
export const recordRecurringExpenses = new RecordRecurringExpensesJob(recurring, groupMembers, clock);

export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [
        new RecordExpenseCommandHandler(groupMembers, groupCurrency, offeredRates, expenses, clock, templates),
      ],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(groupMembers, groupCurrency, offeredRates, expenses, clock, templates)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(groupMembers, expenses, clock)],
    },
    {
      event: SetUpRecurringExpenseCommandEvent,
      handlers: [new SetUpRecurringExpenseCommandHandler(groupMembers, groupCurrency, recurring, clock)],
    },
    {
      event: StopRecurringExpenseCommandEvent,
      handlers: [new StopRecurringExpenseCommandHandler(groupMembers, recurring)],
    },
    {
      event: SetBudgetCommandEvent,
      handlers: [new SetBudgetCommandHandler(groupMembers, budgets)],
    },
    {
      event: RemoveBudgetCommandEvent,
      handlers: [new RemoveBudgetCommandHandler(groupMembers, budgets)],
    },
    {
      event: SaveTemplateCommandEvent,
      handlers: [new SaveTemplateCommandHandler(groupMembers, templates)],
    },
    {
      event: ReplaceTemplateCommandEvent,
      handlers: [new ReplaceTemplateCommandHandler(groupMembers, templates)],
    },
    {
      event: RemoveTemplateCommandEvent,
      handlers: [new RemoveTemplateCommandHandler(groupMembers, templates)],
    },
    {
      event: AttachReceiptCommandEvent,
      handlers: [new AttachReceiptCommandHandler(groupMembers, expenseQueries, receiptStore, receipts)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseQueries, groupMembers),
    new GetGroupBudgetsQueryHandler(budgetQueries, groupMembers, clock),
    new GetReceiptQueryHandler(receiptQueries, expenseQueries, groupMembers),
    new GetGroupTemplatesQueryHandler(templateQueries, groupMembers),
    new GetGroupBalancesQueryHandler(balanceQueries, groupMembers),
    new GetGroupAuditQueryHandler(auditQueries, settlementAudit, passedBalances, groupMembers),
    new GetGroupExpensesQueryHandler(expenseQueries, groupMembers),
    new GetMemberStatementQueryHandler(statementQueries, groupMembers, settledAmounts),
    new GetMemberStatementCsvQueryHandler(statementQueries, groupMembers, settledAmounts),
    new GetOfferedRateQueryHandler(offeredRates, groupCurrency, clock),
    new GetRecurringExpenseQueryHandler(recurringQueries, groupMembers),
    new GetGroupRecurringExpensesQueryHandler(recurringQueries, groupMembers),
  ],
  integrationEvents: [
    {
      event: GroupsMergedIntegrationEvent,
      handlers: [
        new GroupsMergedIntegrationEventHandler(expenseQueries, expenses, recurringQueries, recurring, auditEntries),
      ],
    },
  ],
  domainEvents: [
    {
      event: ExpenseRecordedEvent,
      handlers: [new ExpenseRecordedHandler(), new ExpenseRecordedBudgetHandler(budgetPolicy)],
    },
    { event: ExpenseEditedEvent, handlers: [new ExpenseEditedBudgetHandler(budgetPolicy)] },
    { event: BudgetPassedEvent, handlers: [new BudgetPassedHandler()] },
    {
      event: RecurringExpenseDayCameEvent,
      handlers: [new RecurringExpenseDayCameHandler(expenses, groupMembers, clock)],
    },
  ],
});
