import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { groupQueries } from '@Contexts/Groups/module.local';
import { RecordExpenseCommandEvent, RecordExpenseCommandHandler } from '@Contexts/Ledger/Application/Commands';
import { GetExpenseQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteExpenseQueries';
import { GroupsMembership } from '@Contexts/Ledger/Infrastructure/Groups/GroupsMembership';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3): the expenses of each group, kept in the application's
 * SQLite file. It asks Groups who may be in a split through its own port, answered over Groups' read model; the clock
 * is the application's, passed to what decides a time: an expense's day.
 */
const database = applicationDatabase();
const expenses = new SqliteExpenseRepository(database);
const expenseQueries = new SqliteExpenseQueries(database);
const groupMembers = new GroupsMembership(groupQueries);
const clock = systemClock;

export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(groupMembers, expenses, clock)],
    },
  ],
  queries: [new GetExpenseQueryHandler(expenseQueries, groupMembers)],
});
