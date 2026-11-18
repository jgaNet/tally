import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupMembers } from '@Contexts/Groups/module.local';
import { settledAmounts as settlementsSettledAmounts } from '@Contexts/Settlements/module.local';
import {
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RecordExpense';
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
  GetGroupExpensesQueryHandler,
  GetGroupRecurringExpensesQueryHandler,
  GetMemberStatementQueryHandler,
  GetOfferedRateQueryHandler,
  GetRecurringExpenseQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { GroupCurrencyFromGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyFromGroups';
import { HttpRatesService } from '@Contexts/Ledger/Infrastructure/HttpRatesService';
import { GroupMembersFromGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteExpenseReadModels';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SettledAmountsFromSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsFromSettlements';
import { SqliteMemberBalances } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalances';
import { SqliteRecurringExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseReadModels';
import { SqliteRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseRepository';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
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
    { event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] },
    {
      event: RecurringExpenseDayCameEvent,
      handlers: [new RecurringExpenseDayCameHandler(expenses, currencies, systemClock, balances)],
    },
  ],
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(expenses, members, currencies, offeredRates, systemClock, balances)],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(expenses, members, currencies, offeredRates, systemClock, balances)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(expenses, members, balances)],
    },
    {
      event: SetUpRecurringExpenseCommandEvent,
      handlers: [new SetUpRecurringExpenseCommandHandler(recurringExpenses, members, systemClock)],
    },
    {
      event: StopRecurringExpenseCommandEvent,
      handlers: [new StopRecurringExpenseCommandHandler(recurringExpenses, members)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseReadModels, members),
    new GetGroupBalancesQueryHandler(balances, members),
    new GetGroupExpensesQueryHandler(expenseReadModels, members),
    new GetMemberStatementQueryHandler(expenseReadModels, members),
    new GetOfferedRateQueryHandler(offeredRates, members, currencies, systemClock),
    new GetRecurringExpenseQueryHandler(recurringReadModels, members),
    new GetGroupRecurringExpensesQueryHandler(recurringReadModels, members),
  ],
});
