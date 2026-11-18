import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { getGroupBalances } from '@Contexts/Ledger/Application/Balances';
import { getGroupExpenses, getMemberStatement, getMemberStatementCsv } from '@Contexts/Ledger/Application/History';
import { deleteExpense, editExpense, getExpense, recordExpense } from '@Contexts/Ledger/Application/Expenses';
import { getOfferedRate } from '@Contexts/Ledger/Application/Rates';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { MoveMergedGroupHandler } from '@Contexts/Ledger/Application/Events/MoveMergedGroupHandler';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { PassBudgetHandler } from '@Contexts/Ledger/Application/Events/PassBudgetHandler';
import { PublishBudgetPassedHandler } from '@Contexts/Ledger/Application/Events/PublishBudgetPassedHandler';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Budget';
import { PostgresBudgetStore, budgetsTablesSchema } from '@Contexts/Ledger/Infrastructure/PostgresBudgetStore';
import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';
import {
  PostgresSplitTemplateStore,
  splitTemplatesTablesSchema,
} from '@Contexts/Ledger/Infrastructure/PostgresSplitTemplateStore';
import {
  getGroupTemplates,
  removeTemplate,
  replaceTemplate,
  saveTemplate,
} from '@Contexts/Ledger/Application/SplitTemplates';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IReceiptStore } from '@Contexts/Ledger/Application/IReceiptStore';
import { attachReceipt, getReceipt } from '@Contexts/Ledger/Application/Receipts';
import { PostgresReceiptBook, receiptsTablesSchema } from '@Contexts/Ledger/Infrastructure/PostgresReceiptBook';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';
import { PostgresBalanceRoster } from '@Contexts/Ledger/Infrastructure/PostgresBalanceRoster';
import { PostgresExpenseStore, ledgerTablesSchema } from '@Contexts/Ledger/Infrastructure/PostgresExpenseStore';
import { PostgresAuditLog, auditTablesSchema } from '@Contexts/Ledger/Infrastructure/PostgresAuditLog';
import { ISettlementAudit } from '@Contexts/Ledger/Application/ISettlementAudit';
import { IPassedBalances } from '@Contexts/Ledger/Application/IPassedBalances';
import { getGroupAudit } from '@Contexts/Ledger/Application/Audit';
import { getMyInsights } from '@Contexts/Ledger/Application/Insights';
import {
  PostgresRecurringExpenseStore,
  recurringExpensesTablesSchema,
} from '@Contexts/Ledger/Infrastructure/PostgresRecurringExpenseStore';
import { RecordRecurringExpenseHandler } from '@Contexts/Ledger/Application/Events/RecordRecurringExpenseHandler';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  setUpRecurringExpense,
  stopRecurringExpense,
  sweepRecurringExpenses,
} from '@Contexts/Ledger/Application/RecurringExpenses';

/**
 * The Ledger context (conventions/domain.yaml, ADRs 1, 6 and 10): its wiring, as data. Expenses are kept over the tables the
 * composition root opens with `ledgerSchema`, after the groups' (they name a group). Who may be in a split is Groups' roster,
 * given by the composition root (`roster`, Groups' wiring exports it): Ledger's own port is built over it, so Ledger imports
 * no part of Groups but the roster's type. What the settlements moved in a balance is given the same way (`settled`, ADR 10):
 * every balance Ledger reads counts the settlements recorded so far. The module lists each use case once.
 */
export const ledgerSchema = [
  ...ledgerTablesSchema,
  ...recurringExpensesTablesSchema,
  ...budgetsTablesSchema,
  ...splitTemplatesTablesSchema,
  ...receiptsTablesSchema,
  ...auditTablesSchema,
];

/**
 * The balances of a group's members, as Ledger's read model gives them to Groups when a member asks to leave (feature 9), and to
 * Settlements when it decides a settlement or suggests one. It is over the database, what the settlements moved (`settled`) and the
 * members Ledger asks (`groupMembers`, which carries what passed when members left, request 20), so the composition root can build it
 * before Ledger's own wiring: each is built over the database alone.
 */
export function ledgerBalanceRoster(
  database: PostgresDatabase,
  settled: ISettledAmounts,
  groupMembers: IGroupMembers,
): IBalanceRoster {
  return new PostgresBalanceRoster(database, settled, groupMembers);
}

/**
 * The Ledger module, over the database, Groups' members (`groupMembers`, built over Groups' roster), the group's currency
 * (`groupCurrency`, the same roster: an expense in another currency is converted to it, request 21), the rates a rates service
 * offers (`rates`, request 22: an expense in another currency takes the rate offered when its own is left out, and is checked
 * against it) and what the settlements moved. The composition root builds `groupMembers` once, so the balance read model and this
 * module share it. The receipts store (`receiptStore`, request 26, ADR 21) is the outside place a receipt's file is kept, given by the composition
 * root: it is built over RECEIPTS_URL, and keeps nothing when that is not set.
 */
export function ledgerWiring(
  database: PostgresDatabase,
  groupMembers: IGroupMembers,
  groupCurrency: IGroupCurrency,
  rates: IOfferedRates,
  settled: ISettledAmounts,
  receiptStore: IReceiptStore,
  settlementAudit: ISettlementAudit,
  passedBalances: IPassedBalances,
): LiteModule {
  const expenses = new PostgresExpenseStore(database);
  const recurring = new PostgresRecurringExpenseStore(database);
  const budgets = new PostgresBudgetStore(database);
  const templates = new PostgresSplitTemplateStore(database);
  const receipts = new PostgresReceiptBook(database);
  const audit = new PostgresAuditLog(database);

  return new LiteModule({
    name: 'Ledger',
    domainEvents: [
      {
        event: ExpenseRecordedEvent,
        handlers: [new ExpenseRecordedHandler(), new PassBudgetHandler(budgets, expenses, groupMembers, systemClock)],
      },
      { event: ExpenseEditedEvent, handlers: [new PassBudgetHandler(budgets, expenses, groupMembers, systemClock)] },
      { event: BudgetPassedEvent, handlers: [new PublishBudgetPassedHandler()] },
      {
        event: RecurringExpenseDayCameEvent,
        handlers: [new RecordRecurringExpenseHandler(expenses, groupMembers, groupCurrency, audit, systemClock)],
      },
    ],
    integrationEvents: [
      {
        event: GroupsMergedIntegrationEvent,
        handlers: [new MoveMergedGroupHandler(expenses, recurring, audit, systemClock)],
      },
    ],
    useCases: [
      recordExpense(expenses, templates, groupMembers, groupCurrency, rates, audit, systemClock),
      editExpense(expenses, templates, groupMembers, groupCurrency, rates, audit, systemClock),
      deleteExpense(expenses, groupMembers, groupCurrency, audit, systemClock),
      getGroupAudit(audit, settlementAudit, passedBalances, groupMembers),
      getExpense(expenses, groupMembers),
      getOfferedRate(groupMembers, groupCurrency, rates, systemClock),
      getGroupBalances(expenses, groupMembers, settled),
      getGroupExpenses(expenses, groupMembers),
      getMemberStatement(expenses, groupMembers, settled),
      getMemberStatementCsv(expenses, groupMembers, settled),
      setUpRecurringExpense(recurring, groupMembers, systemClock),
      stopRecurringExpense(recurring, groupMembers, systemClock),
      getRecurringExpense(recurring, groupMembers),
      getGroupRecurringExpenses(recurring, groupMembers),
      sweepRecurringExpenses(recurring, groupMembers, systemClock),
      setBudget(budgets, groupMembers, systemClock),
      removeBudget(budgets, groupMembers, systemClock),
      getGroupBudgets(budgets, expenses, groupMembers, systemClock),
      saveTemplate(templates, groupMembers, systemClock),
      replaceTemplate(templates, groupMembers, systemClock),
      removeTemplate(templates, groupMembers, systemClock),
      getGroupTemplates(templates, groupMembers),
      attachReceipt(expenses, groupMembers, receipts, receiptStore, systemClock),
      getReceipt(expenses, groupMembers, receipts),
      getMyInsights(expenses, groupMembers, groupCurrency),
    ],
  });
}
