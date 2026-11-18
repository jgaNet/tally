import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupsReadModel, settledAmountsOfSettlements } from '@Bootstrap/Fastify/readModels';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  getOfferedRate,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { RecurringExpenseDayCameHandler } from '@Contexts/Ledger/Application/Events/RecurringExpenseDayCameHandler';
import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  recordRecurringDay,
  setUpRecurringExpense,
  stopRecurringExpense,
  sweepRecurringExpenses,
} from '@Contexts/Ledger/Application/RecurringExpenses';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { GroupCurrencyOfGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyOfGroups';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { HttpOfferedRates } from '@Contexts/Ledger/Infrastructure/HttpOfferedRates';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SqliteRecurringExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseQueries';
import { SqliteRecurringExpenses } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenses';

/**
 * The Ledger context (conventions/domain.yaml, ADR 0001, ADR 0004): the expenses of each group and their splits. Its
 * adapters are the application's SQLite file; who may be in a split is asked of Groups' read model, which Groups' wiring
 * exports for this purpose; its clock is the system's, given to the use case that records a time.
 */
const expenses = new SqliteExpenseRepository(sharedDatabase);
const groupMembers = new GroupMembersOfGroups(groupsReadModel);
// The group's currency, for an expense paid in another one (request 21, docs/adr/0020): read over the same Groups read model.
const groupCurrency = new GroupCurrencyOfGroups(groupsReadModel);
// The rates offered for an expense in another currency (request 22, docs/adr/0021): the rates service named by RATES_URL, read at each call.
const offeredRates = new HttpOfferedRates();
const expenseQueries = new SqliteExpenseQueries(sharedDatabase, settledAmountsOfSettlements, groupMembers);
// The recurring expenses (request 23, docs/adr/0022): their own table, read by the queries and stepped by the background job.
const recurring = new SqliteRecurringExpenses(sharedDatabase);
const recurringQueries = new SqliteRecurringExpenseQueries(sharedDatabase);
const recordDay = recordRecurringDay(recurring, groupMembers, systemClock);

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  useCases: [
    recordExpense(expenses, groupMembers, groupCurrency, offeredRates, systemClock),
    getExpense(expenseQueries, groupMembers),
    getGroupBalances(expenseQueries, groupMembers),
    editExpense(expenses, groupMembers, groupCurrency, offeredRates, systemClock),
    deleteExpense(expenses, groupMembers),
    getGroupExpenses(expenseQueries, groupMembers),
    getMemberStatement(expenseQueries, groupMembers),
    getOfferedRate(groupCurrency, offeredRates, systemClock),
    setUpRecurringExpense(recurring, groupMembers, systemClock),
    stopRecurringExpense(recurring, groupMembers),
    getRecurringExpense(recurringQueries, groupMembers),
    getGroupRecurringExpenses(recurringQueries, groupMembers),
    recordDay,
  ],
  domainEvents: [
    // An expense recorded is told to the other contexts as the published fact (request 17, docs/adr/0017).
    { event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] },
    // A recurring expense's day came: its expense is recorded, once, with the id the fact carries (request 23, docs/adr/0022).
    {
      event: RecurringExpenseDayCameEvent,
      handlers: [new RecurringExpenseDayCameHandler(expenses, systemClock)],
    },
  ],
});

/**
 * The background job's run for recurring expenses (request 23, docs/adr/0022), run by the composition root at every
 * `JOBS_INTERVAL_SECONDS`: each recurring expense whose day has come records it, once, whatever the servers.
 */
export const sweepRecurringExpenseDays = (context: ExecutionContext): Promise<void> =>
  sweepRecurringExpenses({ queries: recurringQueries, recordDay, clock: systemClock }, context);
