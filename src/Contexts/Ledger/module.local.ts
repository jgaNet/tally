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
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupExpensesQueryHandler,
  GetMemberStatementQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { GroupCurrencyFromGroups } from '@Contexts/Ledger/Infrastructure/GroupCurrencyFromGroups';
import { GroupMembersFromGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteExpenseReadModels';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SettledAmountsFromSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsFromSettlements';
import { SqliteMemberBalances } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalances';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecorded/ExpenseRecordedHandler';

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
 * What has been settled in the group, read through the port Ledger owns (ADR 7): Settlements' read model, read when it is asked
(ADR 4), so that a balance counts a settlement as soon as it is recorded.
 */
const settled = new SettledAmountsFromSettlements(() => settlementsSettledAmounts);
/** The balances: counted into in the transaction of each expense, and read by a member of the group (T4), with what is settled. */
const balances = new SqliteMemberBalances(database, settled, members);

/** A member's balance in a group, read by Groups before the member leaves it (ADR 4): Ledger's read model, exported. */
export const memberBalances: IMemberBalancesQueries = balances;

/** The Ledger context: the expenses of each group, how each is split, and what each member owes or is owed. */
export const localLedgerModule = new Module({
  name: 'Ledger',
  domainEvents: [{ event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] }],
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(expenses, members, currencies, systemClock, balances)],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(expenses, members, currencies, systemClock, balances)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(expenses, members, balances)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseReadModels, members),
    new GetGroupBalancesQueryHandler(balances, members),
    new GetGroupExpensesQueryHandler(expenseReadModels, members),
    new GetMemberStatementQueryHandler(expenseReadModels, members),
  ],
});
