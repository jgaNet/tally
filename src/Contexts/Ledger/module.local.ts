import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  groupsReadModel,
  ledgerReadModel,
  passedBalancesOfGroups,
  settledAmountsOfSettlements,
  settlementAuditOfSettlements,
} from '@Bootstrap/Fastify/readModels';
import { getGroupAudit } from '@Contexts/Ledger/Application/Audit';
import { SqliteAuditQueries } from '@Contexts/Ledger/Infrastructure/SqliteAuditEntries';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  getMemberStatementCsv,
  getOfferedRate,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseBudgetHandler } from '@Contexts/Ledger/Application/Events/ExpenseBudgetHandler';
import { BudgetPassedHandler } from '@Contexts/Ledger/Application/Events/BudgetPassedHandler';
import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';
import {
  getGroupTemplates,
  removeTemplate,
  replaceTemplate,
  saveTemplate,
} from '@Contexts/Ledger/Application/SplitTemplates';
import { SqliteSplitTemplateQueries } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplateQueries';
import { SqliteSplitTemplates } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplates';
import { attachReceipt, getReceipt } from '@Contexts/Ledger/Application/Receipts';
import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/HttpReceiptStore';
import { SqliteReceiptQueries } from '@Contexts/Ledger/Infrastructure/SqliteReceiptQueries';
import { SqliteReceipts } from '@Contexts/Ledger/Infrastructure/SqliteReceipts';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { ExpenseEditedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { SqliteBudgetQueries } from '@Contexts/Ledger/Infrastructure/SqliteBudgetQueries';
import { SqliteBudgets } from '@Contexts/Ledger/Infrastructure/SqliteBudgets';
import { SqliteMonthlySpending } from '@Contexts/Ledger/Infrastructure/SqliteMonthlySpending';
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
// The monthly budgets (request 24, docs/adr/0023): their own table, the spending a month makes read from the expenses inside the reaction's transaction.
const budgets = new SqliteBudgets(sharedDatabase);
const budgetQueries = new SqliteBudgetQueries(sharedDatabase);
const spending = new SqliteMonthlySpending(sharedDatabase);
// The split templates (request 25, docs/adr/0024): their own table; an expense split by one reads it inside its own transaction.
const templates = new SqliteSplitTemplates(sharedDatabase);
const templateQueries = new SqliteSplitTemplateQueries(sharedDatabase);
// The receipts (request 26, docs/adr/0025): their own table, and the file kept in the receipts store named by RECEIPTS_URL, read at each call.
const receipts = new SqliteReceipts(sharedDatabase);
const receiptQueries = new SqliteReceiptQueries(sharedDatabase);
const receiptStore = new HttpReceiptStore();
// The group's audit (request 28, docs/adr/0027): the expenses' entries are Ledger's own table; the settlements' and the balances that
// passed are read through the ports below, over the other contexts' read models (readModels.ts).
const auditQueries = new SqliteAuditQueries(sharedDatabase);

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  useCases: [
    recordExpense(expenses, groupMembers, groupCurrency, offeredRates, systemClock, templates),
    getExpense(expenseQueries, groupMembers),
    getGroupBalances(expenseQueries, groupMembers),
    editExpense(expenses, groupMembers, groupCurrency, offeredRates, systemClock, templates),
    deleteExpense(expenses, groupMembers, systemClock),
    getGroupExpenses(expenseQueries, groupMembers),
    getMemberStatement(expenseQueries, groupMembers),
    // The statement the CSV is rendered from (request 29, docs/adr/0028): the same read, rendered by the route as text/csv.
    getMemberStatementCsv(expenseQueries, groupMembers),
    getOfferedRate(groupCurrency, offeredRates, systemClock),
    setUpRecurringExpense(recurring, groupMembers, systemClock),
    stopRecurringExpense(recurring, groupMembers),
    getRecurringExpense(recurringQueries, groupMembers),
    getGroupRecurringExpenses(recurringQueries, groupMembers),
    recordDay,
    setBudget(budgets, groupMembers),
    removeBudget(budgets, groupMembers),
    getGroupBudgets(budgetQueries, groupMembers, systemClock),
    saveTemplate(templates, groupMembers),
    replaceTemplate(templates, groupMembers),
    removeTemplate(templates, groupMembers),
    getGroupTemplates(templateQueries, groupMembers),
    // The expense is read over Ledger's own read model, on a connection of its own: the command's transaction holds the shared one (readModels.ts).
    attachReceipt(receipts, receiptStore, ledgerReadModel, groupMembers),
    getReceipt(receiptQueries, expenseQueries, groupMembers),
    getGroupAudit(auditQueries, settlementAuditOfSettlements, passedBalancesOfGroups, groupMembers),
  ],
  domainEvents: [
    // An expense recorded is told to the other contexts as the published fact (request 17, docs/adr/0017), and may pass its month's budget (request 24).
    {
      event: ExpenseRecordedEvent,
      handlers: [new ExpenseRecordedHandler(), new ExpenseBudgetHandler(expenses, budgets, spending, groupMembers)],
    },
    // An expense edited may pass the budget of its month and category (request 24, docs/adr/0023).
    {
      event: ExpenseEditedEvent,
      handlers: [new ExpenseBudgetHandler(expenses, budgets, spending, groupMembers)],
    },
    // A month passed a budget is told to the other contexts as the published fact (request 24, docs/adr/0023).
    { event: BudgetPassedEvent, handlers: [new BudgetPassedHandler()] },
    // A recurring expense's day came: its expense is recorded, once, with the id the fact carries (request 23, docs/adr/0022).
    {
      event: RecurringExpenseDayCameEvent,
      handlers: [new RecurringExpenseDayCameHandler(expenses, groupMembers, systemClock)],
    },
  ],
});

/**
 * The background job's run for recurring expenses (request 23, docs/adr/0022), run by the composition root at every
 * `JOBS_INTERVAL_SECONDS`: each recurring expense whose day has come records it, once, whatever the servers.
 */
export const sweepRecurringExpenseDays = (context: ExecutionContext): Promise<void> =>
  sweepRecurringExpenses({ queries: recurringQueries, recordDay, clock: systemClock }, context);
