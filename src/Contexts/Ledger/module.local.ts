import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
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
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/BudgetEvents';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/ExpenseEvents';
import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';
import {
  getGroupTemplates,
  removeTemplate,
  replaceTemplate,
  saveTemplate,
} from '@Contexts/Ledger/Application/SplitTemplates';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseEvents';
import { BudgetPassedHandler } from '@Contexts/Ledger/Application/Events/BudgetPassedHandler';
import { ExpenseBudgetHandler } from '@Contexts/Ledger/Application/Events/ExpenseBudgetHandler';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { RecurringExpenseDayCameHandler } from '@Contexts/Ledger/Application/Events/RecurringExpenseDayCameHandler';
import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  setUpRecurringExpense,
  stopRecurringExpense,
  sweepRecurringExpenses,
} from '@Contexts/Ledger/Application/RecurringExpenses';
import { SqliteBudgets } from '@Contexts/Ledger/Infrastructure/SqliteBudgets';
import { SqliteSplitTemplates } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplates';
import { SqliteRecurringExpenses } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenses';
import { BalancesCountingSettlements } from '@Contexts/Ledger/Infrastructure/BalancesCountingSettlements';
import { GroupCurrencyOfGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyOfGroups';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { LedgerDatabase } from '@Contexts/Ledger/Infrastructure/LedgerDatabase';
import { OfferedRatesOverHttp } from '@Contexts/Ledger/Infrastructure/OfferedRatesOverHttp';
import { SettledAmountsOfSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsOfSettlements';
import { SqliteExpenses } from '@Contexts/Ledger/Infrastructure/SqliteExpenses';
import { settlementsReadModel } from '@Contexts/Settlements/module.local';

/**
 * The Ledger context, as data (ADR 1, ADR 5): its expenses in SQLite at `LEDGER_DATABASE_PATH`, or the application's
 * database file (`DATABASE_PATH`) when that is not set, read when the first request needs it. Ledger asks Groups who the
 * members of a group are through its own `GroupMembers` port, answered over Groups' read model, which Groups' wiring
 * exports and nothing else of Groups is reached through.
 */
const database = new LedgerDatabase(
  () => process.env.LEDGER_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
const expenses = new SqliteExpenses(database);
/** The recurring expenses (request 23), in the same file as the expenses they record. */
const recurringExpenses = new SqliteRecurringExpenses(database);
/** The monthly budgets of the categories (request 24), in the same file as the expenses they are held against. */
const budgets = new SqliteBudgets(database);
/** The split templates (request 25), in the same file as the expenses an expense split by one of them is recorded in. */
const splitTemplates = new SqliteSplitTemplates(database);
const groupMembers = new GroupMembersOfGroups(() => groupsMembersReadModel);
/** The currency of a group, which an expense paid in another currency is counted against (request 21, ADR 18), read at a request too. */
const groupCurrency = new GroupCurrencyOfGroups(() => groupsMembersReadModel);
/**
 * The rate a rates service offers for a currency on a day (request 22, ADR 19), read at `RATES_URL` when a request needs it. Unset, the
 * server has no rates service: an expense then takes the payer's rate, and one that leaves its rate out is refused.
 */
const offeredRates = new OfferedRatesOverHttp(() => process.env.RATES_URL);
/** What the group's settlements paid, read from Settlements' read model at a request, never when the modules are built (ADR 7, ADR 11). */
const settledAmounts = new SettledAmountsOfSettlements(() => settlementsReadModel);
/** The balances as every reader sees them: the expenses', plus the settlements (request 12). */
const balancesCountingSettlements = new BalancesCountingSettlements(expenses, settledAmounts, groupMembers);

/**
 * The balances, the read model of the balances, which Groups asks through its own `MemberBalances` port before a member leaves
 * (ADR 7), and Settlements asks for its suggestions (ADR 10): the one thing of Ledger another context reaches through this file. It
 * counts the settlements of the group (ADR 11). Groups' wiring imports this one and this one imports Groups' and Settlements', each for
 * the read model the other asks; all are read at a request (ADR 7).
 */
export const ledgerBalancesReadModel = balancesCountingSettlements;

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  domainEvents: [
    {
      event: ExpenseRecordedEvent,
      handlers: [new ExpenseRecordedHandler(), new ExpenseBudgetHandler(budgets, expenses, groupMembers, systemClock)],
    },
    { event: ExpenseEditedEvent, handlers: [new ExpenseBudgetHandler(budgets, expenses, groupMembers, systemClock)] },
    { event: BudgetPassedEvent, handlers: [new BudgetPassedHandler()] },
    { event: RecurringExpenseDayCameEvent, handlers: [new RecurringExpenseDayCameHandler(expenses, groupMembers)] },
  ],
  useCases: [
    recordExpense(expenses, groupMembers, groupCurrency, offeredRates, splitTemplates, systemClock),
    getExpense(expenses, groupMembers),
    getGroupBalances(balancesCountingSettlements, groupMembers),
    getGroupExpenses(expenses, groupMembers),
    getMemberStatement(expenses, groupMembers),
    editExpense(expenses, groupMembers, groupCurrency, offeredRates, splitTemplates, systemClock),
    deleteExpense(expenses, groupMembers, systemClock),
    getOfferedRate(groupCurrency, groupMembers, offeredRates, systemClock),
    setUpRecurringExpense(recurringExpenses, groupMembers, systemClock),
    stopRecurringExpense(recurringExpenses, groupMembers, systemClock),
    getRecurringExpense(recurringExpenses, groupMembers),
    getGroupRecurringExpenses(recurringExpenses, groupMembers),
    sweepRecurringExpenses(recurringExpenses, groupMembers, systemClock),
    setBudget(budgets, groupMembers, systemClock),
    removeBudget(budgets, groupMembers, systemClock),
    getGroupBudgets(budgets, expenses, groupMembers, systemClock),
    saveTemplate(splitTemplates, groupMembers, systemClock),
    replaceTemplate(splitTemplates, groupMembers, systemClock),
    removeTemplate(splitTemplates, groupMembers, systemClock),
    getGroupTemplates(splitTemplates, groupMembers),
  ],
});
