import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
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
} from '@Contexts/Ledger/Application/Commands';
import {
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupExpensesQueryHandler,
  GetMemberStatementQueryHandler,
  GetOfferedRateQueryHandler,
  GetRecurringExpenseQueryHandler,
  GetGroupRecurringExpensesQueryHandler,
  GetGroupBudgetsQueryHandler,
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
import { SqliteBudgetRepository } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteBudgetRepository';
import { SqliteBudgetQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteBudgetQueries';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { SqliteRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteRecurringExpenseRepository';
import { SqliteRecurringExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteRecurringExpenseQueries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteExpenseQueries';
import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteBalanceQueries';
import { SqliteStatementQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteStatementQueries';
import { GroupsMembership } from '@Contexts/Ledger/Infrastructure/Groups/GroupsMembership';
import { GroupsCurrency } from '@Contexts/Ledger/Infrastructure/Groups/GroupsCurrency';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/Settlements/SettlementsSettledAmounts';
import { HttpOfferedRates } from '@Contexts/Ledger/Infrastructure/Rates/HttpOfferedRates';
import { settlementQueries } from '@Contexts/Settlements/module.local';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3): the expenses of each group, kept in the application's
 * SQLite file, with the balances read model written by each expense (ADR 1). It asks Groups who may be in a split, and
 * who the members of a group are, through its own port, answered over Groups' read model; it asks the rates service the rate
 * offered for an expense in another currency, through its own port (request 22); the clock is the application's,
 * passed to what decides a time: an expense's day. An expense's recording is published to the other contexts as
 * ExpenseRecorded (request 17, ADR 6), through the outbox. A recurring expense (request 23) is set up and stopped by its commands, and
 * its days are recorded by the background job `recordRecurringExpenses`, which the composition root schedules; the expense of a day is
 * recorded by the policy on its fact.
 */
const database = applicationDatabase();
const expenses = new SqliteExpenseRepository(database);
const expenseQueries = new SqliteExpenseQueries(database);
const groupMembers = new GroupsMembership(groupQueries);
const groupCurrency = new GroupsCurrency(groupQueries);
/** The rates service is asked where RATES_URL points when a rate is asked, so an unset URL offers none (request 22). */
const offeredRates = new HttpOfferedRates(() => process.env.RATES_URL);
const balanceQueries = new SqliteBalanceQueries(
  database,
  new SettlementsSettledAmounts(settlementQueries),
  groupMembers,
);
const statementQueries = new SqliteStatementQueries(database);
const recurring = new SqliteRecurringExpenseRepository(database);
const recurringQueries = new SqliteRecurringExpenseQueries(database);
const budgets = new SqliteBudgetRepository(database);
const budgetQueries = new SqliteBudgetQueries(database);
/** The policy on an expense recorded or edited (request 24): its month, in its category, is what the budget decides. */
const budgetPolicy = new ExpenseBudgetPolicy(expenses, budgets, budgetQueries, groupMembers);
const clock = systemClock;

/** The sweep of request 23: run by the composition root every JOBS_INTERVAL_SECONDS, recording each day that has come, once. */
export const recordRecurringExpenses = new RecordRecurringExpensesJob(recurring, groupMembers, clock);

export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(groupMembers, groupCurrency, offeredRates, expenses, clock)],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(groupMembers, groupCurrency, offeredRates, expenses, clock)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(groupMembers, expenses)],
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
  ],
  queries: [
    new GetExpenseQueryHandler(expenseQueries, groupMembers),
    new GetGroupBudgetsQueryHandler(budgetQueries, groupMembers, clock),
    new GetGroupBalancesQueryHandler(balanceQueries, groupMembers),
    new GetGroupExpensesQueryHandler(expenseQueries, groupMembers),
    new GetMemberStatementQueryHandler(statementQueries, groupMembers),
    new GetOfferedRateQueryHandler(offeredRates, groupCurrency, clock),
    new GetRecurringExpenseQueryHandler(recurringQueries, groupMembers),
    new GetGroupRecurringExpensesQueryHandler(recurringQueries, groupMembers),
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
