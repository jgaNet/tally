import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupAudit, groupMembers } from '@Contexts/Groups/module.local';
import {
  settledAmounts as settlementsSettledAmounts,
  settlementAudit as settlementsAudit,
} from '@Contexts/Settlements/module.local';
import {
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RecordExpense';
import {
  RemoveBudgetCommandEvent,
  RemoveBudgetCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RemoveBudget';
import { SetBudgetCommandEvent, SetBudgetCommandHandler } from '@Contexts/Ledger/Application/Commands/SetBudget';
import {
  AttachReceiptCommandEvent,
  AttachReceiptCommandHandler,
} from '@Contexts/Ledger/Application/Commands/AttachReceipt';
import {
  SaveTemplateCommandEvent,
  SaveTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/SaveTemplate';
import {
  ReplaceTemplateCommandEvent,
  ReplaceTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/ReplaceTemplate';
import {
  RemoveTemplateCommandEvent,
  RemoveTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RemoveTemplate';
import {
  DeleteExpenseCommandEvent,
  DeleteExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/DeleteExpense';
import { EditExpenseCommandEvent, EditExpenseCommandHandler } from '@Contexts/Ledger/Application/Commands/EditExpense';
import {
  SetUpRecurringExpenseCommandEvent,
  SetUpRecurringExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense';
import {
  StopRecurringExpenseCommandEvent,
  StopRecurringExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/StopRecurringExpense';
import {
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupBudgetsQueryHandler,
  GetGroupExpensesQueryHandler,
  GetGroupRecurringExpensesQueryHandler,
  GetMemberStatementCsvQueryHandler,
  GetMemberStatementQueryHandler,
  GetOfferedRateQueryHandler,
  GetRecurringExpenseQueryHandler,
  GetGroupTemplatesQueryHandler,
  GetReceiptQueryHandler,
  GetGroupAuditQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { SqliteAuditLog } from '@Contexts/Ledger/Infrastructure/SqliteAuditLog';
import { SettlementAuditFromSettlements } from '@Contexts/Ledger/Infrastructure/SettlementAuditFromSettlements';
import { PassedBalancesFromGroups } from '@Contexts/Ledger/Infrastructure/PassedBalancesFromGroups';
import { GroupCurrencyFromGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyFromGroups';
import { HttpRatesService } from '@Contexts/Ledger/Infrastructure/HttpRatesService';
import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/HttpReceiptStore';
import { SqliteReceiptReadModels } from '@Contexts/Ledger/Infrastructure/SqliteReceiptReadModels';
import { SqliteReceiptRepository } from '@Contexts/Ledger/Infrastructure/SqliteReceiptRepository';
import { GroupMembersFromGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteBudgetReadModels } from '@Contexts/Ledger/Infrastructure/SqliteBudgetReadModels';
import { SqliteBudgetRepository } from '@Contexts/Ledger/Infrastructure/SqliteBudgetRepository';
import { SqliteSplitTemplateReadModels } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplateReadModels';
import { SqliteSplitTemplateRepository } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplateRepository';
import { SqliteExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteExpenseReadModels';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SettledAmountsFromSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsFromSettlements';
import { SqliteMemberBalances } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalances';
import { SqliteRecurringExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseReadModels';
import { SqliteRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseRepository';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { BudgetPassedHandler } from '@Contexts/Ledger/Application/Events/BudgetPassed/BudgetPassedHandler';
import { ExpenseBudgetCheckHandler } from '@Contexts/Ledger/Application/Events/ExpenseBudgetCheck/ExpenseBudgetCheckHandler';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecorded/ExpenseRecordedHandler';
import { RecurringExpenseDayCameHandler } from '@Contexts/Ledger/Application/Events/RecurringExpenseDayCame';
import { RecurringExpenseSweepJob } from '@Contexts/Ledger/Application/Jobs/RecurringExpenseSweep/RecurringExpenseSweepJob';

const database = sharedDatabase();
const expenses = new SqliteExpenseRepository(database);
const expenseReadModels = new SqliteExpenseReadModels(database);
/**
 * Who may be in a split: Groups' membership, read through the port Ledger owns (ADR 3). Groups' wiring imports `memberBalances`
 * from this file too (ADR 4), so the port reads Groups' export when it is asked, not while this file is evaluated.
 */
const members = new GroupMembersFromGroups(() => groupMembers);
/**
 * The group's currency, which an expense paid in another currency is converted into (request 21), read through the port Ledger
 * owns beside membership (ADR 12): Groups' read model, read when it is asked, as the membership port is.
 */
const currencies = new GroupCurrencyFromGroups(() => groupMembers);
/**
 * The rates an expense in another currency takes or corrects against (request 22), read through the port Ledger owns (ADR 13): a
 * rates service over its HTTP API, read when it is asked, so a server started without `RATES_URL` offers no rate and takes the payer's.
 */
const offeredRates = new HttpRatesService();
/**
 * What has been settled in the group, read through the port Ledger owns (ADR 7): Settlements' read model, read when it is asked
(ADR 4), so that a balance counts a settlement as soon as it is recorded.
 */
const settled = new SettledAmountsFromSettlements(() => settlementsSettledAmounts);
/** The balances: counted into in the transaction of each expense, and read by a member of the group (T4), with what is settled. */
const balances = new SqliteMemberBalances(database, settled, members);
/** The recurring expenses (request 23): what each is, kept between the runs of the sweep, and their read models. */
const recurringExpenses = new SqliteRecurringExpenseRepository(database);
const recurringReadModels = new SqliteRecurringExpenseReadModels(database);
/** The budgets (request 24): one per group and category, and what a month spends in each, read from the expenses above. */
const budgets = new SqliteBudgetRepository(database);
const budgetReadModels = new SqliteBudgetReadModels(database);
/** The split templates (request 25): saved under a name in a group, and the splits expenses are split by in place of their own. */
const splitTemplates = new SqliteSplitTemplateRepository(database);
const templateReadModels = new SqliteSplitTemplateReadModels(database);
/**
 * The receipts (request 26, ADR 17): one per expense, kept in the receipts store the server is started with (`RECEIPTS_URL`, read when a
 * file is kept, so a server started without it refuses every receipt). The store is Ledger's port; its adapter is an HTTP client.
 */
const receipts = new SqliteReceiptRepository(database);
/**
 * The audit of the money (request 28, ADR 19): the expenses' entries are Ledger's own; the settlements' and the balances passed are read
 * through the ports Ledger owns, each written by the context that made the change.
 */
const audit = new SqliteAuditLog(database);
// What a member's statement reads (requests 8 and 29): the group's members, when each expense was recorded, and the settlements counted.
const statementSources = { groupMembers: members, audit, settled };
const settlementAudit = new SettlementAuditFromSettlements(() => settlementsAudit);
const passedBalances = new PassedBalancesFromGroups(() => groupAudit);
const receiptReadModels = new SqliteReceiptReadModels(database);
const receiptStore = new HttpReceiptStore();
/**
 * The sweep of the recurring expenses (request 23, ADR 14): the process runs it every JOBS_INTERVAL_SECONDS, as the debt sweep (ADR 10),
 * in a context of its own. It takes the one clock, and the members are read through the port Ledger owns (ADR 3).
 */
export const recurringExpenseSweep = new RecurringExpenseSweepJob(recurringExpenses, members, systemClock);

/** A member's balance in a group, read by Groups before the member leaves it (ADR 4): Ledger's read model, exported. */
export const memberBalances: IMemberBalancesQueries = balances;

/** The Ledger context: the expenses of each group, how each is split, and what each member owes or is owed. */
export const localLedgerModule = new Module({
  name: 'Ledger',
  domainEvents: [
    {
      event: ExpenseRecordedEvent,
      handlers: [
        new ExpenseRecordedHandler(),
        // Asks the category's budget whether the expense's month has passed it (request 24).
        new ExpenseBudgetCheckHandler(expenses, budgets, budgetReadModels, members),
      ],
    },
    {
      event: ExpenseEditedEvent,
      handlers: [new ExpenseBudgetCheckHandler(expenses, budgets, budgetReadModels, members)],
    },
    { event: BudgetPassedEvent, handlers: [new BudgetPassedHandler()] },
    {
      event: RecurringExpenseDayCameEvent,
      handlers: [new RecurringExpenseDayCameHandler(expenses, currencies, systemClock, balances, members, audit)],
    },
  ],
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [
        new RecordExpenseCommandHandler(
          expenses,
          members,
          currencies,
          offeredRates,
          systemClock,
          balances,
          splitTemplates,
          audit,
        ),
      ],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [
        new EditExpenseCommandHandler(
          expenses,
          members,
          currencies,
          offeredRates,
          systemClock,
          balances,
          splitTemplates,
          audit,
        ),
      ],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(expenses, members, balances, systemClock, audit)],
    },
    {
      event: SetUpRecurringExpenseCommandEvent,
      handlers: [new SetUpRecurringExpenseCommandHandler(recurringExpenses, members, systemClock)],
    },
    { event: SetBudgetCommandEvent, handlers: [new SetBudgetCommandHandler(budgets, members)] },
    {
      event: AttachReceiptCommandEvent,
      handlers: [new AttachReceiptCommandHandler(expenseReadModels, receipts, receiptStore, members)],
    },
    { event: RemoveBudgetCommandEvent, handlers: [new RemoveBudgetCommandHandler(budgets, members)] },
    { event: SaveTemplateCommandEvent, handlers: [new SaveTemplateCommandHandler(splitTemplates, members)] },
    { event: ReplaceTemplateCommandEvent, handlers: [new ReplaceTemplateCommandHandler(splitTemplates, members)] },
    { event: RemoveTemplateCommandEvent, handlers: [new RemoveTemplateCommandHandler(splitTemplates, members)] },
    {
      event: StopRecurringExpenseCommandEvent,
      handlers: [new StopRecurringExpenseCommandHandler(recurringExpenses, members)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseReadModels, members),
    new GetGroupBalancesQueryHandler(balances, members),
    new GetGroupBudgetsQueryHandler(budgetReadModels, members, systemClock),
    new GetGroupTemplatesQueryHandler(templateReadModels, members),
    new GetReceiptQueryHandler(receiptReadModels, expenseReadModels, members),
    new GetGroupExpensesQueryHandler(expenseReadModels, members),
    new GetGroupAuditQueryHandler(audit, settlementAudit, passedBalances, members),
    new GetMemberStatementQueryHandler(expenseReadModels, statementSources),
    new GetMemberStatementCsvQueryHandler(expenseReadModels, statementSources),
    new GetOfferedRateQueryHandler(offeredRates, members, currencies, systemClock),
    new GetRecurringExpenseQueryHandler(recurringReadModels, members),
    new GetGroupRecurringExpensesQueryHandler(recurringReadModels, members),
  ],
});
