import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { groupQueries } from '@Contexts/Groups/module.local';
import {
  DeleteExpenseCommandEvent,
  DeleteExpenseCommandHandler,
  EditExpenseCommandEvent,
  EditExpenseCommandHandler,
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands';
import {
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupExpensesQueryHandler,
  GetMemberStatementQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteExpenseQueries';
import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteBalanceQueries';
import { SqliteStatementQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteStatementQueries';
import { GroupsMembership } from '@Contexts/Ledger/Infrastructure/Groups/GroupsMembership';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3): the expenses of each group, kept in the application's
 * SQLite file, with the balances read model written by each expense (ADR 1). It asks Groups who may be in a split, and
 * who the members of a group are, through its own port, answered over Groups' read model; the clock is the application's,
 * passed to what decides a time: an expense's day.
 */
const database = applicationDatabase();
const expenses = new SqliteExpenseRepository(database);
const expenseQueries = new SqliteExpenseQueries(database);
const balanceQueries = new SqliteBalanceQueries(database);
const statementQueries = new SqliteStatementQueries(database);
const groupMembers = new GroupsMembership(groupQueries);
const clock = systemClock;

export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(groupMembers, expenses, clock)],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(groupMembers, expenses, clock)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(groupMembers, expenses)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseQueries, groupMembers),
    new GetGroupBalancesQueryHandler(balanceQueries, groupMembers),
    new GetGroupExpensesQueryHandler(expenseQueries, groupMembers),
    new GetMemberStatementQueryHandler(statementQueries, groupMembers),
  ],
});
