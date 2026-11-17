import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { groupMembership, groupMembershipInCommand } from '@Contexts/Groups/module.local';
import { settlementEffects, settlementEffectsInCommand } from '@Contexts/Settlements/module.local';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { SqliteMemberBalanceSums } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalanceSums';
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
import { SqliteGroupBalanceSumsInCommand } from '@Contexts/Ledger/Infrastructure/SqliteGroupBalanceSumsInCommand';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/SettlementsSettledAmounts';
import { GroupsMembers } from '@Contexts/Ledger/Infrastructure/GroupsMembers';
import { SqliteStatementQueries } from '@Contexts/Ledger/Infrastructure/SqliteStatementQueries';
import { IGroupBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupBalanceSums';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3, ADR 7): the expenses of each group, recorded with their equal
 * split, the members' balances read from them and from what the settlements paid, and read by the members of the group,
 * kept in the application's SQLite file (ADR 2). Who may be in a split is asked of Groups through the read model Groups'
 * wiring exports, and what was settled of Settlements' read model its wiring exports (ADR 7); neither wiring imports
 * this one.
 */
const database = SqliteDatabase.shared();

/** What the settlements paid, as Ledger reads it: outside a transaction for a query, inside the asking command's for a command. */
const settledForQueries = new SettlementsSettledAmounts(settlementEffects);
const settledInCommand = new SettlementsSettledAmounts(settlementEffectsInCommand);

/**
 * Ledger's balance of a member as Groups asks it when a member leaves (MemberBalances, ADR 4), exported for a command:
 * it reads inside the asking command's transaction. The composition root hands it to Groups' module.
 */
export const memberBalanceSumsInCommand: IMemberBalanceSums = new SqliteMemberBalanceSums(database, settledInCommand);

/**
 * The balances of each group as Settlements reads them (GroupBalances, ADR 5), exported for a query: outside any
 * transaction. The composition root's Settlements wiring takes it; this wiring does not import Settlements' module.
 */
export const groupBalanceSums: IGroupBalanceSums = new SqliteBalanceQueries(database, settledForQueries);

/**
 * The balances of each group as a settlement is decided on them (GroupBalances, ADR 7), exported for a command: inside
 * the asking command's transaction, so that the second of two settlements decided at once reads the first one's.
 */
export const groupBalanceSumsInCommand: IGroupBalanceSums = new SqliteGroupBalanceSumsInCommand(
  database,
  settledInCommand,
);

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
    new GetGroupBalancesQueryHandler(
      new SqliteBalanceQueries(database, settledForQueries),
      new GroupsMembers(groupMembership),
    ),
    new GetGroupExpensesQueryHandler(new SqliteExpenseQueries(database), new GroupsMembers(groupMembership)),
    new GetMemberStatementQueryHandler(new SqliteStatementQueries(database), new GroupsMembers(groupMembership)),
  ],
});
