import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { LedgerDatabase } from '@Contexts/Ledger/Infrastructure/LedgerDatabase';
import { SqliteExpenses } from '@Contexts/Ledger/Infrastructure/SqliteExpenses';

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
const groupMembers = new GroupMembersOfGroups(groupsMembersReadModel);

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  useCases: [
    recordExpense(expenses, groupMembers, systemClock),
    getExpense(expenses, groupMembers),
    getGroupBalances(expenses, groupMembers),
    editExpense(expenses, groupMembers, systemClock),
    deleteExpense(expenses, groupMembers, systemClock),
  ],
});
