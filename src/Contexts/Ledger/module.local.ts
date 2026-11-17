import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getGroupBalances } from '@Contexts/Ledger/Application/Balances';
import { getGroupExpenses, getMemberStatement } from '@Contexts/Ledger/Application/History';
import { deleteExpense, editExpense, getExpense, recordExpense } from '@Contexts/Ledger/Application/Expenses';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';
import { GroupMembersFromGroups, GroupRoster } from '@Contexts/Ledger/Infrastructure/GroupMembersFromGroups';
import { SqliteBalanceRoster } from '@Contexts/Ledger/Infrastructure/SqliteBalanceRoster';
import { SqliteExpenseStore, ledgerTablesSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseStore';

/**
 * The Ledger context (conventions/domain.yaml, ADRs 1, 6 and 10): its wiring, as data. Expenses are kept over the tables the
 * composition root opens with `ledgerSchema`, after the groups' (they name a group). Who may be in a split is Groups' roster,
 * given by the composition root (`roster`, Groups' wiring exports it): Ledger's own port is built over it, so Ledger imports
 * no part of Groups but the roster's type. What the settlements moved in a balance is given the same way (`settled`, ADR 10):
 * every balance Ledger reads counts the settlements recorded so far. The module lists each use case once.
 */
export const ledgerSchema = ledgerTablesSchema;

/**
 * The balances of a group's members, as Ledger's read model gives them to Groups when a member asks to leave (feature 9), and to
 * Settlements when it decides a settlement or suggests one. It is over the database and what the settlements moved (`settled`), so the
 * composition root can build it before Ledger's own wiring, which needs Groups' roster.
 */
export function ledgerBalanceRoster(database: SqliteDatabase, settled: ISettledAmounts): IBalanceRoster {
  return new SqliteBalanceRoster(database, settled);
}

/** The Ledger module, over the database, the roster of Groups and what the settlements moved. */
export function ledgerWiring(database: SqliteDatabase, roster: GroupRoster, settled: ISettledAmounts): LiteModule {
  const expenses = new SqliteExpenseStore(database);
  const groupMembers = new GroupMembersFromGroups(roster);

  return new LiteModule({
    name: 'Ledger',
    domainEvents: [{ event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] }],
    useCases: [
      recordExpense(expenses, groupMembers, systemClock),
      editExpense(expenses, groupMembers, systemClock),
      deleteExpense(expenses, groupMembers, systemClock),
      getExpense(expenses, groupMembers),
      getGroupBalances(expenses, groupMembers, settled),
      getGroupExpenses(expenses, groupMembers),
      getMemberStatement(expenses, groupMembers),
    ],
  });
}
