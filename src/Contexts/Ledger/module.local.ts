import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getGroupBalances } from '@Contexts/Ledger/Application/Balances';
import { getGroupExpenses, getMemberStatement } from '@Contexts/Ledger/Application/History';
import { deleteExpense, editExpense, getExpense, recordExpense } from '@Contexts/Ledger/Application/Expenses';
import { GroupMembersFromGroups, GroupRoster } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteExpenseStore, ledgerTablesSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseStore';

/**
 * The Ledger context (conventions/domain.yaml, ADRs 1 and 6): its wiring, as data. Expenses are kept over the tables the
 * composition root opens with `ledgerSchema`, after the groups' (they name a group). Who may be in a split is Groups' roster,
 * given by the composition root (`roster`, Groups' wiring exports it): Ledger's own port is built over it, so Ledger imports
 * no part of Groups but the roster's type. The module lists each use case once.
 */
export const ledgerSchema = ledgerTablesSchema;

/** The Ledger module, over the database and the roster of Groups. */
export function ledgerWiring(database: SqliteDatabase, roster: GroupRoster): LiteModule {
  const expenses = new SqliteExpenseStore(database);
  const groupMembers = new GroupMembersFromGroups(roster);

  return new LiteModule({
    name: 'Ledger',
    useCases: [
      recordExpense(expenses, groupMembers, systemClock),
      editExpense(expenses, groupMembers, systemClock),
      deleteExpense(expenses, groupMembers, systemClock),
      getExpense(expenses, groupMembers),
      getGroupBalances(expenses, groupMembers),
      getGroupExpenses(expenses, groupMembers),
      getMemberStatement(expenses, groupMembers),
    ],
  });
}
