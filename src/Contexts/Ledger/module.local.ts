import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupMembers } from '@Contexts/Groups/module.local';
import {
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RecordExpense';
import {
  DeleteExpenseCommandEvent,
  DeleteExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/DeleteExpense';
import { EditExpenseCommandEvent, EditExpenseCommandHandler } from '@Contexts/Ledger/Application/Commands/EditExpense';
import { GetExpenseQueryHandler, GetGroupBalancesQueryHandler } from '@Contexts/Ledger/Application/Queries';
import { GroupMembersFromGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteExpenseReadModels } from '@Contexts/Ledger/Infrastructure/SqliteExpenseReadModels';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SqliteMemberBalances } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalances';

const database = sharedDatabase();
const expenses = new SqliteExpenseRepository(database);
const expenseReadModels = new SqliteExpenseReadModels(database);
/** Who may be in a split: Groups' membership, read through the port Ledger owns (ADR 3). */
const members = new GroupMembersFromGroups(groupMembers);
/** The balances: counted into in the transaction of each expense, and read by a member of the group (T4). */
const balances = new SqliteMemberBalances(database);

/** The Ledger context: the expenses of each group, how each is split, and what each member owes or is owed. */
export const localLedgerModule = new Module({
  name: 'Ledger',
  commands: [
    {
      event: RecordExpenseCommandEvent,
      handlers: [new RecordExpenseCommandHandler(expenses, members, systemClock, balances)],
    },
    {
      event: EditExpenseCommandEvent,
      handlers: [new EditExpenseCommandHandler(expenses, members, systemClock, balances)],
    },
    {
      event: DeleteExpenseCommandEvent,
      handlers: [new DeleteExpenseCommandHandler(expenses, members, balances)],
    },
  ],
  queries: [
    new GetExpenseQueryHandler(expenseReadModels, members),
    new GetGroupBalancesQueryHandler(balances, members),
  ],
});
