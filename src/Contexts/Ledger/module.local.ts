import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { groupMembership, groupMembershipInCommand } from '@Contexts/Groups/module.local';
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
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/SqliteBalanceQueries';
import { GroupsMembers } from '@Contexts/Ledger/Infrastructure/GroupsMembers';
import { SqliteStatementQueries } from '@Contexts/Ledger/Infrastructure/SqliteStatementQueries';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3): the expenses of each group, recorded with their equal
 * split, the members' balances read from them, and read by the members of the group, kept in the application's SQLite file (ADR 2). Who may be in a split is
 * asked of Groups through the read model Groups' wiring exports, the one link ADR 3 declares.
 */
const database = SqliteDatabase.shared();

export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [
        new RecordExpenseCommandHandler(
          new SqliteExpenseRepository(database),
          new GroupsMembers(groupMembershipInCommand),
          systemClock,
        ),
      ],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [
        new EditExpenseCommandHandler(
          new SqliteExpenseRepository(database),
          new GroupsMembers(groupMembershipInCommand),
          systemClock,
        ),
      ],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [
        new DeleteExpenseCommandHandler(
          new SqliteExpenseRepository(database),
          new GroupsMembers(groupMembershipInCommand),
          systemClock,
        ),
      ],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(new SqliteExpenseQueries(database), new GroupsMembers(groupMembership)),
    new GetGroupBalancesQueryHandler(new SqliteBalanceQueries(database), new GroupsMembers(groupMembership)),
    new GetGroupExpensesQueryHandler(new SqliteExpenseQueries(database), new GroupsMembers(groupMembership)),
    new GetMemberStatementQueryHandler(new SqliteStatementQueries(database), new GroupsMembers(groupMembership)),
  ],
});
